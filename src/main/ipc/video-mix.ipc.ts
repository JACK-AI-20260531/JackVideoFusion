/**
 * 视频混剪 IPC 注册
 *
 * 职责:将 videoMixService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   video-mix:start  - 启动混剪任务(入队 + 执行 + 完成/失败回调)
 *   video-mix:cancel - 取消混剪任务(token.cancel + taskQueue.cancel)
 *   video-mix:pause  - 暂停(状态 paused + token.cancel 杀 ffmpeg,保留 checkpoint)
 *   video-mix:resume - 恢复(新建 token + runMix 从最近 checkpoint 续渲染)
 *
 * 断点续渲染机制:
 *  - pause 先 taskQueue.pause(running→paused) 再 token.cancel 杀 ffmpeg
 *  - runMix 抛 CANCELLED 时,executeMix 检测 task.status==='paused',
 *    不调 taskQueue.fail,保留 checkpoint,返回 result=null 告知渲染层"已暂停"
 *  - resume 从 taskQueue.get(taskId).params 取回原参数,新建 token,再次调 runMix
 *  - runMix 内部 loadCheckpoint 跳过已完成步骤(详见 random-mixer / audio-matcher)
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
 * 用于 cancel/pause 时找到对应令牌触发取消
 */
const activeTokens = new Map<string, CancelToken>();

/**
 * 执行混剪并处理完成/失败/暂停三种结局
 * - 完成:taskQueue.complete + 返回 result
 * - 失败:taskQueue.fail + 抛出错误
 * - 暂停(用户主动):保留 paused 状态与 checkpoint,返回 null(不抛错)
 * @param taskId 任务 ID
 * @param params 混剪参数
 * @param token 取消令牌
 * @param source 调用来源(start/resume),用于日志
 * @returns 混剪结果;暂停时返回 null
 */
async function executeMix(
  taskId: string,
  params: MixParams,
  token: CancelToken,
  source: 'start' | 'resume',
): Promise<MixResult | null> {
  try {
    const result = await videoMixService.runMix(params, taskId, token);
    taskQueue.complete(taskId, result.outputPath);
    activeTokens.delete(taskId);
    logger.info(`[IPC] video-mix:${source} 任务 ${taskId} 完成: ${result.outputPath}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
    const task = taskQueue.get(taskId);
    const isPaused = isCancelled && task && task.status === 'paused';

    if (!isCancelled) {
      taskQueue.fail(taskId, msg);
    }
    activeTokens.delete(taskId);

    if (isPaused) {
      // 用户暂停:保留 paused 状态与 checkpoint,不抛错
      logger.info(
        `[IPC] video-mix:${source} 任务 ${taskId} 已暂停(用户主动,checkpoint 保留)`,
      );
      return null;
    }

    logger.error(`[IPC] video-mix:${source} 任务 ${taskId} 失败: ${msg}`);
    throw err;
  }
}

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

    const result = await executeMix(taskId, params, token, 'start');
    return { taskId, result };
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
   * 先 taskQueue.pause(running→paused)再 token.cancel 杀 ffmpeg 子进程。
   * runMix 会抛 CANCELLED,executeMix 检测 task.status==='paused' 后保留 checkpoint。
   * payload: { taskId }
   * 返回: { paused: taskId }
   */
  safeHandle(ipc, 'video-mix:pause', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('video-mix:pause 入参缺失 taskId');
    }
    // 先切换状态(running→paused),这样 executeMix 的 catch 能识别为"暂停"而非"取消"
    taskQueue.pause(taskId);
    // 再 cancel token,触发 ffmpeg 子进程退出
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户暂停混剪任务');
      // 不在此处 delete activeTokens — 由 executeMix 的 catch 统一清理
    }
    logger.info(`[IPC] video-mix:pause 任务 ${taskId} 已暂停(token.cancel 已触发)`);
    return { paused: taskId };
  });

  /**
   * 恢复混剪任务(断点续渲染)
   * 从 taskQueue 取回原 params,新建 CancelToken,再次调 runMix。
   * runMix 内部会 loadCheckpoint 跳过已完成步骤。
   * payload: { taskId }
   * 返回: { taskId, result } — result 为 null 表示再次被暂停
   */
  safeHandle(ipc, 'video-mix:resume', async (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('video-mix:resume 入参缺失 taskId');
    }

    const task = taskQueue.get(taskId);
    if (!task) {
      throw new Error(`video-mix:resume 任务不存在: ${taskId}`);
    }
    if (task.status !== 'paused') {
      throw new Error(`video-mix:resume 任务非暂停状态(当前: ${task.status})`);
    }

    // 取回原参数
    const params = task.params as unknown as MixParams;

    // 新建 token 替换旧的(旧 token 已 cancelled 不可复用)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    // 恢复状态(paused→running)
    taskQueue.resume(taskId);
    logger.info(`[IPC] video-mix:resume 任务 ${taskId} 恢复执行(从 checkpoint 续渲染)`);

    const result = await executeMix(taskId, params, token, 'resume');
    return { taskId, result };
  });
}
