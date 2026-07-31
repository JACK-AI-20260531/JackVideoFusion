/**
 * 发布任务队列
 *
 * 职责:
 *   - 管理发布任务,复用 task-queue(TaskItem)进行状态机管理与进度推送
 *   - 串行执行(避免浏览器并发与平台风控),支持取消
 *   - 频率限制:每平台默认每分钟 1 条,超出则等待
 *   - 进度推送:通过 taskQueue.updateProgress 推送,渲染层订阅 task:progress
 *
 * 设计要点:
 *   - enqueue 将 PublishTask 同步映射为 TaskItem 入 taskQueue,并加入内部串行链执行
 *   - 串行链用 Promise 链实现,保证任务依次执行,单个任务失败不中断后续
 *   - 取消通过 CancelToken 实现,adapter.publish 在步骤间检查 token
 */
import { CancelToken } from '../ffmpeg/types';
import { taskQueue } from '../task-queue';
import type { TaskItem } from '../task-queue/types';
import { logger } from '../../utils/logger';
import { adapterFactory, PLATFORM_NAMES } from './adapters';
import type { PublishTask, PublishParams, PublishPlatform } from './types';

/** 频率限制间隔:每平台每分钟 1 条(毫秒) */
const RATE_LIMIT_INTERVAL_MS = 60 * 1000;

/**
 * PublishQueue 发布任务队列
 * 串行执行发布任务,集成 task-queue 进行状态管理与进度推送
 */
export class PublishQueue {
  /** 串行执行链:所有任务依次排队执行 */
  private chain: Promise<void> = Promise.resolve();
  /** 活跃任务的 CancelToken 映射:taskId → CancelToken */
  private cancelTokens = new Map<string, CancelToken>();
  /** 平台最近发布时间戳:用于频率限制 */
  private lastPublishAt = new Map<PublishPlatform, number>();
  /** 本地任务记录:taskId → PublishTask */
  private tasks = new Map<string, PublishTask>();

  /**
   * 创建发布任务对象(生成 id 与初始字段)
   * @param params 发布参数
   * @returns 发布任务对象
   */
  createTask(params: PublishParams): PublishTask {
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      params,
      status: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 入队发布任务
   * 同步映射为 TaskItem 入 taskQueue(触发状态机与进度推送),并加入内部串行链执行
   * @param task 发布任务
   * @returns 任务 ID
   */
  enqueue(task: PublishTask): string {
    this.tasks.set(task.id, task);

    // 构造 TaskItem 入 taskQueue,类型 'auto-publish'
    const taskItem: TaskItem = {
      id: task.id,
      type: 'auto-publish',
      title: `发布到${PLATFORM_NAMES[task.params.platform]}:${task.params.title}`,
      status: 'pending',
      progress: 0,
      params: task.params as unknown as Record<string, unknown>,
      createdAt: task.createdAt,
    };
    taskQueue.enqueue(taskItem);

    // 加入串行执行链(单个任务异常不中断后续)
    this.chain = this.chain
      .then(() => this.runOne(task))
      .catch((err) => {
        logger.error(
          `[auto-publish] 串行链执行异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    logger.info(
      `[auto-publish] 任务 ${task.id} 已入队 平台=${task.params.platform} 标题=${task.params.title}`,
    );
    return task.id;
  }

  /**
   * 取消发布任务
   * 设置 CancelToken 并触发 taskQueue.cancel
   * @param taskId 任务 ID
   */
  cancel(taskId: string): void {
    const token = this.cancelTokens.get(taskId);
    if (token) {
      token.cancel(`用户取消发布任务 ${taskId}`);
    }
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
    }
    try {
      taskQueue.cancel(taskId);
    } catch (err) {
      logger.warn(
        `[auto-publish] 取消任务 ${taskId} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.info(`[auto-publish] 任务 ${taskId} 已请求取消`);
  }

  /**
   * 列出所有本地发布任务
   * @returns 发布任务数组(按创建时间升序)
   */
  list(): PublishTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 执行单个发布任务(串行链内部调用)
   * 流程:频率限制等待 → 适配器 publish → 完成/失败/取消状态同步
   * @param task 发布任务
   */
  private async runOne(task: PublishTask): Promise<void> {
    const { id, params } = task;
    const token = new CancelToken(id);
    this.cancelTokens.set(id, token);

    try {
      // 频率限制:每平台每分钟 1 条
      await this.waitForRateLimit(params.platform, token);
      if (token.cancelled) {
        task.status = 'cancelled';
        return;
      }
      // 占用频率槽(发布开始即占用,避免失败后立即重试触发风控)
      this.updateLastPublishAt(params.platform);

      task.status = 'running';
      taskQueue.updateProgress(id, 5);

      const adapter = adapterFactory(params.platform);
      const onProgress = (p: number): void => {
        task.progress = p;
        taskQueue.updateProgress(id, p);
      };

      const result = await adapter.publish(params, token, onProgress);

      if (token.cancelled) {
        task.status = 'cancelled';
        try {
          taskQueue.cancel(id);
        } catch {
          // 已是终态则忽略
        }
      } else if (result.success) {
        task.status = 'completed';
        task.progress = 100;
        task.result = result;
        taskQueue.complete(id, result.videoUrl);
        logger.info(`[auto-publish] 任务 ${id} 发布成功`);
      } else {
        task.status = 'failed';
        task.error = '发布失败';
        task.result = result;
        taskQueue.fail(id, '发布失败');
        logger.warn(`[auto-publish] 任务 ${id} 发布失败`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = token.cancelled ? 'cancelled' : 'failed';
      task.error = msg;
      if (token.cancelled) {
        try {
          taskQueue.cancel(id);
        } catch {
          // 忽略
        }
      } else {
        taskQueue.fail(id, msg);
      }
      logger.error(`[auto-publish] 任务 ${id} 执行异常: ${msg}`);
    } finally {
      this.cancelTokens.delete(id);
    }
  }

  /**
   * 等待平台频率限制解除
   * 若距上次发布不足 RATE_LIMIT_INTERVAL_MS,则分段等待(支持取消)
   * @param platform 平台标识
   * @param token 取消令牌
   */
  private async waitForRateLimit(platform: PublishPlatform, token: CancelToken): Promise<void> {
    const last = this.lastPublishAt.get(platform) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed >= RATE_LIMIT_INTERVAL_MS) return;

    let remaining = RATE_LIMIT_INTERVAL_MS - elapsed;
    const step = 1000;
    logger.info(
      `[auto-publish] 平台 ${platform} 频率限制等待 ${Math.ceil(remaining / 1000)}s`,
    );
    while (remaining > 0) {
      if (token.cancelled) return;
      await this.sleep(Math.min(step, remaining));
      remaining -= step;
    }
  }

  /**
   * 更新平台最近发布时间戳
   * @param platform 平台标识
   */
  private updateLastPublishAt(platform: PublishPlatform): void {
    this.lastPublishAt.set(platform, Date.now());
  }

  /**
   * 睡眠工具方法
   * @param ms 毫秒
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** 发布任务队列单例 */
export const publishQueue = new PublishQueue();
