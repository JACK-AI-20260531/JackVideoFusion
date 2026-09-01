/**
 * 发布任务队列
 *
 * 职责:
 *   - 管理发布任务,复用 task-queue(TaskItem)进行状态机管理与进度推送
 *   - 串行执行(避免浏览器并发与平台风控),支持取消
 *   - 频率限制:每平台默认每分钟 1 条,超出则等待
 *   - 进度推送:通过 this.tq.updateProgress 推送,渲染层订阅 task:progress
 *
 * 设计要点:
 *   - enqueue 将 PublishTask 同步映射为 TaskItem 入 taskQueue,并加入内部串行链执行
 *   - 串行链用 Promise 链实现,保证任务依次执行,单个任务失败不中断后续
 *   - 取消通过 CancelToken 实现,adapter.publish 在步骤间检查 token
 */
import { CancelToken } from '../ffmpeg/types';
import { taskQueue } from '../task-queue';
import type { TaskItem, TaskQueue } from '../task-queue/types';
import { logger } from '../../utils/logger';
import { adapterFactory, PLATFORM_NAMES } from './adapters';
import { scheduleStore as defaultScheduleStore, classifySchedule } from './schedule-store';
import type { ScheduleStore } from './schedule-store';
import { analyticsStore } from './analytics-store';
import type { AnalyticsStore } from './analytics-store';
import type { PublishTask, PublishParams, PublishPlatform, PlatformAdapter } from './types';
import { computeScheduleDelayMs } from './schedule';

/** 错过定时发布时间的提示文案(任务中心可见,可一键立即执行) */
export const MISSED_SCHEDULE_MSG = '错过定时发布时间(应用未运行)';

/**
 * PublishQueue 依赖注入参数
 * 便于测试注入 mock 的 taskQueue 与适配器工厂,绕过真实浏览器
 */
export interface PublishQueueDeps {
  /** 任务队列(默认使用全局 taskQueue 单例) */
  taskQueue?: TaskQueue;
  /** 适配器工厂(默认使用全局 adapterFactory) */
  adapterFactory?: (platform: PublishPlatform) => PlatformAdapter;
  /** 定时条目存储(默认使用全局 scheduleStore 单例) */
  scheduleStore?: Pick<ScheduleStore, 'upsert' | 'markStatus' | 'get'>;
  /** 分析存储(默认使用全局 analyticsStore 单例;发布成功自动绑定用) */
  analytics?: Pick<AnalyticsStore, 'bind'>;
}

/** 频率限制间隔:每平台每分钟 1 条(毫秒) */
const RATE_LIMIT_INTERVAL_MS = 60 * 1000;
/** 启动时最多恢复未来 24h 内的定时任务(毫秒),避免恢复过早遗留的历史排定 */
const SCHEDULED_MAX_RESTORE_MS = 24 * 60 * 60 * 1000;

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
  /** 定时发布定时器:taskId → Timeout */
  private scheduledTimers = new Map<string, NodeJS.Timeout>();
  /** 定时发布中的任务:taskId → PublishTask(等待到点执行) */
  private scheduledTasks = new Map<string, PublishTask>();
  /** 处于"暂停"状态的任务:taskId → 存在即暂停 */
  private pausedTasks = new Set<string>();
  /** 注入的任务队列 */
  private readonly tq: TaskQueue;
  /** 注入的适配器工厂 */
  private readonly af: (platform: PublishPlatform) => PlatformAdapter;
  /** 注入的定时条目存储 */
  private readonly sStore: Pick<ScheduleStore, 'upsert' | 'markStatus' | 'get'>;
  /** 注入的分析存储(发布成功自动绑定) */
  private readonly aStore: Pick<AnalyticsStore, 'bind'>;

  /**
   * @param deps 可选依赖注入(默认使用全局单例)
   */
  constructor(deps: PublishQueueDeps = {}) {
    this.tq = deps.taskQueue ?? taskQueue;
    this.af = deps.adapterFactory ?? adapterFactory;
    this.sStore = deps.scheduleStore ?? defaultScheduleStore;
    this.aStore = deps.analytics ?? analyticsStore;
  }

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
   * 同步映射为 TaskItem 入 taskQueue(触发状态机与进度推送)。
   * 若指定了未来的 scheduledAt,则登记定时器到点后执行;否则加入内部串行链立即执行。
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
    this.tq.enqueue(taskItem);

    // 定时发布:若 scheduledAt 在未来,登记定时器(不入立即链)
    const delayMs = this.scheduleDelayMs(task.params.scheduledAt);
    if (delayMs !== null) {
      this.scheduledTasks.set(task.id, task);
      this.scheduledTimers.set(
        task.id,
        setTimeout(() => {
          this.scheduledTimers.delete(task.id);
          this.scheduledTasks.delete(task.id);
          this.sStore.markStatus(task.id, 'firing');
          this.pushToChain(task);
        }, delayMs),
      );
      // 持久化定时条目(重启可恢复/展示)
      this.sStore.upsert({
        taskId: task.id,
        platform: task.params.platform,
        title: task.params.title,
        scheduledAt: task.params.scheduledAt as string,
        createdAt: task.createdAt,
        status: 'pending',
      });
      logger.info(
        `[auto-publish] 任务 ${task.id} 已排定 平台=${task.params.platform} 标题=${task.params.title}，${Math.round(delayMs / 1000)}s 后自动发布`,
      );
      return task.id;
    }

    this.pushToChain(task);
    return task.id;
  }

  /**
   * 计算定时发布的延迟毫秒数
   * 委托给纯函数 computeScheduleDelayMs
   * @param scheduledAt 定时发布时间(ISO)
   * @returns 距到点的毫秒数;不可定时时返回 null
   */
  private scheduleDelayMs(scheduledAt?: string): number | null {
    return computeScheduleDelayMs(scheduledAt);
  }

  /**
   * 把任务投入串行执行链(复用 Promise 链,单个任务异常不中断后续)
   * @param task 发布任务
   */
  private pushToChain(task: PublishTask): void {
    this.chain = this.chain
      .then(() => this.runOne(task))
      .catch((err) => {
        logger.error(
          `[auto-publish] 串行链执行异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * 取消发布任务
   * 清理定时器(若在等待到点),设置 CancelToken 并触发 this.tq.cancel
   * @param taskId 任务 ID
   */
  cancel(taskId: string): void {
    this.clearSchedule(taskId);
    this.sStore.markStatus(taskId, 'cancelled');
    const token = this.cancelTokens.get(taskId);
    if (token) {
      token.cancel(`用户取消发布任务 ${taskId}`);
    }
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
    }
    try {
      this.tq.cancel(taskId);
    } catch (err) {
      logger.warn(
        `[auto-publish] 取消任务 ${taskId} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.info(`[auto-publish] 任务 ${taskId} 已请求取消`);
  }

  /**
   * 暂停发布任务
   * 语义:把 running/pending/scheduled 任务剥离执行,标记为暂停。
   *  - 定时待发任务:清除定时器,不自动触发
   *  - 正在执行的浏览器操作:通过 CancelToken 中断(等价于中断当前上传)
   *  - 任务状态置为 paused(runOne 的收尾逻辑会识别 paused 而非 cancelled)
   * @param taskId 任务 ID
   * @returns 是否成功暂停(任务不存在或已是终态时返回 false)
   */
  pause(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    // 终态任务不可暂停
    if (task.status === 'completed' || task.status === 'failed') {
      return false;
    }
    // 若在定时待发,清除定时器
    this.clearSchedule(taskId);
    // 离开定时调度(暂停后经 resume 立即重发,不再回到定时表)
    this.sStore.markStatus(taskId, 'cancelled');
    // 标记为暂停
    this.pausedTasks.add(taskId);
    // 中断正在执行的浏览器操作(若存在活跃令牌)
    const token = this.cancelTokens.get(taskId);
    if (token) {
      token.cancel(`用户暂停发布任务 ${taskId}`);
    }
    if (task.status !== 'paused') {
      task.status = 'paused';
    }
    // 同步 taskQueue 状态机(running→paused)
    try {
      this.tq.pause(taskId);
    } catch {
      // 非 running 状态(如 pending)下 pause 可能抛错,忽略即可
    }
    logger.info(`[auto-publish] 任务 ${taskId} 已暂停`);
    return true;
  }

  /**
   * 恢复被暂停的发布任务
   * 把 paused 任务重置为 pending 并重新投入串行执行链(从自动发布流程重新执行)。
   * @param taskId 任务 ID
   * @returns 是否成功恢复(任务不存在或未处于暂停状态时返回 false)
   */
  resume(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (!this.pausedTasks.has(taskId)) {
      return false;
    }
    this.pausedTasks.delete(taskId);
    // 重置为待执行状态(与 retry 一致)
    task.status = 'pending';
    task.progress = 0;
    task.error = undefined;
    task.result = undefined;
    // 重新入 taskQueue 并投入串行执行链
    try {
      this.tq.enqueue(this.buildTaskItem(task));
    } catch (err) {
      logger.warn(
        `[auto-publish] 任务 ${taskId} 恢复入队失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    this.pushToChain(task);
    logger.info(`[auto-publish] 任务 ${taskId} 已恢复,重新发布`);
    return true;
  }

  /**
   * 清除任务的定时器(若存在)
   * @param taskId 任务 ID
   */
  private clearSchedule(taskId: string): void {
    const timer = this.scheduledTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.scheduledTimers.delete(taskId);
    }
    this.scheduledTasks.delete(taskId);
  }

  /**
   * 重试失败的发布任务
   * 仅 failed/cancelled 状态的终态任务可重试:重置为 pending 并重新投入串行执行链。
   * @param taskId 任务 ID
   * @returns 是否成功发起重试(任务不存在或不在可重试状态时返回 false)
   */
  retry(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) {
      return false;
    }
    // 清理可能的残留定时器与取消令牌
    this.clearSchedule(taskId);
    // 重置为待执行状态
    task.status = 'pending';
    task.progress = 0;
    task.error = undefined;
    task.result = undefined;
    // 重新入 taskQueue(同 id 覆盖为 pending 并重新调度)
    try {
      this.tq.enqueue(this.buildTaskItem(task));
    } catch (err) {
      logger.warn(
        `[auto-publish] 任务 ${taskId} 重试入队失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    // 重新投入串行执行链
    this.pushToChain(task);
    logger.info(`[auto-publish] 任务 ${taskId} 已重试 平台=${task.params.platform} 标题=${task.params.title}`);
    return true;
  }

  /**
   * 构造 TaskItem(供入队/重试复用)
   * @param task 发布任务
   */
  private buildTaskItem(task: PublishTask): TaskItem {
    return {
      id: task.id,
      type: 'auto-publish',
      title: `发布到${PLATFORM_NAMES[task.params.platform]}:${task.params.title}`,
      status: 'pending',
      progress: 0,
      params: task.params as unknown as Record<string, unknown>,
      createdAt: task.createdAt,
    };
  }

  /**
   * 列出待执行的定时任务(taskId 列表)
   */
  listScheduled(): string[] {
    return [...this.scheduledTasks.keys()];
  }

  /**
   * 应用启动时恢复定时发布任务
   * 扫描 taskQueue 中 type='auto-publish' 且状态为 pending 的定时任务:
   *   - 未到点(24h 内):重建定时器,并回写定时条目存储为 pending
   *   - 已错过(scheduledAt 已过且应用未运行):标记任务失败并写明原因,
   *     用户可在任务中心一键"立即执行"(retry)补救
   * 注意:重启后 PublishQueue 本地 tasks Map 已丢失,这里通过 TaskItem.params 重建 PublishTask。
   * @returns 恢复的定时任务数量(不含错过标记)
   */
  restoreScheduled(): number {
    let restored = 0;
    for (const item of this.tq.list()) {
      if (item.type !== 'auto-publish' || item.status !== 'pending') continue;
      const params = item.params as unknown as PublishParams | undefined;
      const scheduledAt = params?.scheduledAt;
      const kind = classifySchedule(scheduledAt, Date.now());
      if (kind === 'immediate') continue;

      // 重建本地任务记录
      const task: PublishTask = {
        id: item.id,
        params: {
          platform: params?.platform ?? 'douyin',
          videoPath: params?.videoPath ?? '',
          title: params?.title ?? '',
          description: params?.description,
          tags: params?.tags,
          coverPath: params?.coverPath,
          scheduledAt,
        },
        status: 'pending',
        progress: 0,
        createdAt: item.createdAt,
      };

      if (kind === 'missed') {
        // 错过定时发布:任务队列置为 cancelled(状态机不允许 pending→fail),
        // 定时条目标记 failed + 错过原因,UI 提供一键立即执行(retry 兼容 cancelled)
        this.tasks.set(task.id, task);
        task.status = 'failed';
        task.error = MISSED_SCHEDULE_MSG;
        try {
          this.tq.cancel(item.id);
        } catch (err) {
          logger.warn(
            `[auto-publish] 标记错过任务 ${item.id} 失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.sStore.upsert({
          taskId: task.id,
          platform: task.params.platform,
          title: task.params.title,
          scheduledAt: scheduledAt as string,
          createdAt: task.createdAt,
          status: 'pending',
        });
        this.sStore.markStatus(task.id, 'failed', MISSED_SCHEDULE_MSG);
        logger.info(
          `[auto-publish] 任务 ${item.id} 错过定时发布(scheduledAt=${scheduledAt}),已标记失败等待手动重试`,
        );
        continue;
      }

      const delayMs = this.scheduleDelayMs(scheduledAt);
      if (delayMs === null || delayMs > SCHEDULED_MAX_RESTORE_MS) continue;
      this.tasks.set(task.id, task);
      this.scheduledTasks.set(task.id, task);
      const timer = setTimeout(() => {
        this.scheduledTimers.delete(task.id);
        this.scheduledTasks.delete(task.id);
        this.sStore.markStatus(task.id, 'firing');
        this.pushToChain(task);
      }, delayMs);
      this.scheduledTimers.set(task.id, timer);
      // 回写定时条目存储(保持 pending,重启前的状态以本表为准)
      this.sStore.upsert({
        taskId: task.id,
        platform: task.params.platform,
        title: task.params.title,
        scheduledAt: scheduledAt as string,
        createdAt: task.createdAt,
        status: 'pending',
      });
      restored++;
      logger.info(
        `[auto-publish] 恢复定时任务 ${task.id} 平台=${task.params.platform} 标题=${task.params.title}，${Math.round(delayMs / 1000)}s 后自动发布`,
      );
    }
    return restored;
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
        if (this.pausedTasks.has(id)) {
          task.status = 'paused';
          try {
            this.tq.pause(id);
          } catch {
            // 忽略状态机异常
          }
        } else {
          task.status = 'cancelled';
        }
        return;
      }
      // 占用频率槽(发布开始即占用,避免失败后立即重试触发风控)
      this.updateLastPublishAt(params.platform);

      task.status = 'running';
      this.tq.updateProgress(id, 5);

      const adapter = this.af(params.platform);
      const onProgress = (p: number): void => {
        task.progress = p;
        this.tq.updateProgress(id, p);
      };

      const result = await adapter.publish(params, token, onProgress);

      if (this.pausedTasks.has(id)) {
        // 发布过程被暂停 → 标记为 paused,不当作取消
        task.status = 'paused';
        task.error = '已暂停,可恢复后重新发布';
        try {
          this.tq.pause(id);
        } catch {
          // 忽略状态机异常
        }
      } else if (token.cancelled) {
        task.status = 'cancelled';
        try {
          this.tq.cancel(id);
        } catch {
          // 已是终态则忽略
        }
      } else if (result.success) {
        task.status = 'completed';
        task.progress = 100;
        task.result = result;
        this.tq.complete(id, result.videoUrl);
        this.autoBindAnalytics(task, result);
        logger.info(`[auto-publish] 任务 ${id} 发布成功`);
      } else {
        task.status = 'failed';
        task.error = '发布失败';
        task.result = result;
        this.tq.fail(id, '发布失败');
        logger.warn(`[auto-publish] 任务 ${id} 发布失败`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.pausedTasks.has(id)) {
        // 执行中被打断且任务处于暂停态 → 记为 paused,而非 cancelled
        task.status = 'paused';
        task.error = '已暂停,可恢复后重新发布';
        try {
          this.tq.pause(id);
        } catch {
          // 忽略状态机异常
        }
        logger.warn(`[auto-publish] 任务 ${id} 已被暂停`);
      } else if (token.cancelled) {
        task.status = 'cancelled';
        try {
          this.tq.cancel(id);
        } catch {
          // 忽略
        }
      } else {
        task.status = 'failed';
        task.error = msg;
        this.tq.fail(id, msg);
      }
      logger.error(`[auto-publish] 任务 ${id} 执行异常: ${msg}`);
    } finally {
      this.syncScheduleTerminal(task);
      this.cancelTokens.delete(id);
    }
  }

  /**
   * 发布成功后自动绑定数据分析记录(PRD-v1.7 FR-1 数据飞轮自动化)
   * 适配器返回 videoUrl 时自动写入分析存储,免去手动粘贴;失败静默不阻断
   * @param task 发布任务
   * @param result 发布结果(须 success 且含 videoUrl)
   */
  private autoBindAnalytics(
    task: PublishTask,
    result: NonNullable<PublishTask['result']>,
  ): void {
    if (!result.videoUrl) return;
    try {
      this.aStore.bind({
        taskId: task.id,
        platform: task.params.platform,
        title: task.params.title,
        videoUrl: result.videoUrl,
        videoPath: task.params.videoPath,
      });
      logger.info(
        `[auto-publish] 任务 ${task.id} 已自动绑定数据追踪: ${result.videoUrl}`,
      );
    } catch (err) {
      logger.warn(
        `[auto-publish] 任务 ${task.id} 自动绑定失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 把任务终态同步到定时条目存储(completed→done / failed→failed / cancelled→cancelled)
   * paused 任务已在 pause() 时标记为 cancelled,此处不重复处理
   * @param task 发布任务
   */
  private syncScheduleTerminal(task: PublishTask): void {
    if (task.status === 'completed') {
      this.sStore.markStatus(task.id, 'done');
    } else if (task.status === 'failed') {
      this.sStore.markStatus(task.id, 'failed', task.error ?? '发布失败');
    } else if (task.status === 'cancelled') {
      this.sStore.markStatus(task.id, 'cancelled');
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
