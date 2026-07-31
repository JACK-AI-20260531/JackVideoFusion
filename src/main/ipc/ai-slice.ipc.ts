/**
 * AI 切片 IPC 注册
 *
 * 职责:将 aiSliceService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   ai-slice:start  - 启动 AI 切片任务(入队 + 执行 + 完成/失败回调)
 *   ai-slice:cancel - 取消 AI 切片任务(token.cancel + taskQueue.cancel)
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { aiSliceService } from '../services/ai-slice';
import type { AiSliceParams, AiSliceResult } from '../services/ai-slice';
import { CancelToken, FFmpegError } from '../services/ffmpeg/types';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import type { TaskType } from '../../shared/types';
import { logger } from '../utils/logger';

/**
 * 活跃任务的 CancelToken 映射:taskId → CancelToken
 * 用于 cancel 时找到对应令牌触发取消
 */
const activeTokens = new Map<string, CancelToken>();

/** ai-slice:start 返回结构 */
interface StartResp {
  /** 任务 ID */
  taskId: string;
  /** AI 切片结果 */
  result: AiSliceResult;
}

/**
 * 注册 AI 切片相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 启动 AI 切片任务
   * payload: AiSliceParams
   * 返回: { taskId, result }
   */
  safeHandle(ipc, 'ai-slice:start', async (_event, payload: unknown) => {
    const params = payload as AiSliceParams;
    // 入参校验
    if (
      !params ||
      typeof params.videoPath !== 'string' ||
      params.videoPath.trim().length === 0
    ) {
      throw new Error('ai-slice:start 入参无效:videoPath 必填且不能为空');
    }

    // 构造 TaskItem 入队
    const taskId = `aislice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskType: TaskType = 'ai-slice';
    const task: TaskItem = {
      id: taskId,
      type: taskType,
      title: 'AI 切片',
      status: 'pending',
      progress: 0,
      params: params as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 创建 CancelToken(用 taskId 作为 token.id,便于 ffmpeg 进度推送关联)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    logger.info(`[IPC] ai-slice:start 任务 ${taskId} 已入队`);

    try {
      // 执行 AI 切片(taskQueue 已自动把 pending 转 running)
      const result: AiSliceResult = await aiSliceService.runSlice(params, taskId, token);
      // 标记完成
      taskQueue.complete(taskId);
      activeTokens.delete(taskId);
      logger.info(
        `[IPC] ai-slice:start 任务 ${taskId} 完成: ${result.totalClips} 个切片`,
      );
      const resp: StartResp = { taskId, result };
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 区分取消与其他失败:取消时 taskQueue.cancel 已被调用,此处仅清理 token
      const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
      if (!isCancelled) {
        taskQueue.fail(taskId, msg);
      }
      activeTokens.delete(taskId);
      logger.error(`[IPC] ai-slice:start 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
  });

  /**
   * 取消 AI 切片任务
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'ai-slice:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-slice:cancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消 AI 切片任务');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] ai-slice:cancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });
}
