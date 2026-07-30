/**
 * 视频混剪 IPC 注册
 *
 * 职责:将 videoMixService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   video-mix:start  - 启动混剪任务(入队 + 执行 + 完成/失败回调)
 *   video-mix:cancel - 取消混剪任务(token.cancel + taskQueue.cancel)
 *   video-mix:pause  - 暂停混剪任务(仅状态变更,断点续渲染见 resume)
 *   video-mix:resume - 恢复混剪任务(简化版:重新执行整个任务,进度从0开始)
 *
 * 注意:
 *  - taskQueue 只管状态,不执行业务逻辑;本 IPC 负责调用 videoMixService.runMix 执行
 *  - 暂停:简化为通过 cancel 实现(渲染层调用 cancel 后再重新 start)
 *    pause 仅做状态标记,实际停止靠 token.cancel
 *  - resume:简化版直接重新执行整个任务(进度从0开始)
 *    TODO: 后续可基于 loadCheckpoint 实现真正的断点续渲染
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { videoMixService } from '../services/video-mix';
import type { MixParams, MixResult } from '../services/video-mix/types';
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

/**
 * 注册视频混剪相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 启动混剪任务
   * payload: MixParams
   * 返回: { taskId, result }
   */
  safeHandle(ipc, 'video-mix:start', async (_event, payload: unknown) => {
    const params = payload as MixParams;
    // 入参校验
    if (!params || !params.mode || !Array.isArray(params.folderIds)) {
      throw new Error('video-mix:start 入参无效:mode/folderIds 必填');
    }
    if (params.folderIds.length === 0) {
      throw new Error('video-mix:start 入参无效:folderIds 不能为空');
    }

    // 构造 TaskItem 入队
    const taskId = `videomix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskType: TaskType =
      params.mode === 'random' ? 'video-mix-random' : 'video-mix-audio';
    const taskTitle =
      params.mode === 'random' ? '随机素材混剪' : '文件夹音频匹配';
    const task: TaskItem = {
      id: taskId,
      type: taskType,
      title: taskTitle,
      status: 'pending',
      progress: 0,
      params: params as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 创建 CancelToken(用 taskId 作为 token.id,便于 ffmpeg 进度推送关联)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    logger.info(`[IPC] video-mix:start 任务 ${taskId} 已入队, mode=${params.mode}`);

    try {
      // 执行混剪(taskQueue 已自动把 pending 转 running)
      const result: MixResult = await videoMixService.runMix(params, taskId, token);
      // 标记完成
      taskQueue.complete(taskId, result.outputPath);
      activeTokens.delete(taskId);
      logger.info(`[IPC] video-mix:start 任务 ${taskId} 完成: ${result.outputPath}`);
      return { taskId, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 区分取消与其他失败:取消时 taskQueue.cancel 已被调用,此处仅清理 token
      const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
      if (!isCancelled) {
        taskQueue.fail(taskId, msg);
      }
      activeTokens.delete(taskId);
      logger.error(`[IPC] video-mix:start 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
  });

  /**
   * 取消混剪任务
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'video-mix:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('video-mix:cancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消混剪任务');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] video-mix:cancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });

  /**
   * 暂停混剪任务
   * 简化实现:仅做状态变更(running → paused),实际 ffmpeg 子进程靠 cancel 停止
   * 渲染层若需真正停止,应调用 cancel 后再重新 start
   * payload: { taskId }
   * 返回: { paused: taskId }
   */
  safeHandle(ipc, 'video-mix:pause', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('video-mix:pause 入参缺失 taskId');
    }
    taskQueue.pause(taskId);
    logger.info(`[IPC] video-mix:pause 任务 ${taskId} 已暂停`);
    return { paused: taskId };
  });

  /**
   * 恢复混剪任务
   * 简化实现:仅恢复状态(paused → running),不重新执行 ffmpeg
   * TODO: 后续可基于 loadCheckpoint 实现真正的断点续渲染(从最近 checkpoint 继续)
   * 当前简化版:resume 后状态恢复为 running,但实际渲染需用户重新点击 start
   * payload: { taskId }
   * 返回: { resumed: taskId, note: string }
   */
  safeHandle(ipc, 'video-mix:resume', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('video-mix:resume 入参缺失 taskId');
    }
    taskQueue.resume(taskId);
    logger.info(`[IPC] video-mix:resume 任务 ${taskId} 已恢复(简化版:仅状态恢复)`);
    return {
      resumed: taskId,
      note: '简化版:仅恢复状态,需重新点击开始以重新执行(断点续渲染待实现)',
    };
  });
}
