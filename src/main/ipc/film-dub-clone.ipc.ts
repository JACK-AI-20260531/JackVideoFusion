/**
 * 影视解说克隆 IPC 注册
 *
 * 职责:将 filmDubCloneService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   film-dub-clone:start         - 启动克隆任务(入队 + 执行 + 完成/失败回调)
 *   film-dub-clone:cancel        - 取消克隆任务(token.cancel + taskQueue.cancel)
 *   film-dub-clone:previewRhythm - 节奏预览(仅提取节奏,不入队,直接返回 RhythmPattern)
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { filmDubCloneService } from '../services/film-dub-clone';
import { extractRhythm } from '../services/film-dub-clone/rhythm-extractor';
import type { CloneParams, CloneResult, RhythmPattern } from '../services/film-dub-clone';
import { CancelToken, FFmpegError } from '../services/ffmpeg/types';
import { taskQueue, removeCheckpoint } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import type { TaskType } from '../../shared/types';
import { logger } from '../utils/logger';

/**
 * 活跃任务的 CancelToken 映射:taskId → CancelToken
 * 用于 cancel 时找到对应令牌触发取消
 */
const activeTokens = new Map<string, CancelToken>();

/** film-dub-clone:start 返回结构 */
interface StartResp {
  /** 任务 ID */
  taskId: string;
  /** 克隆结果 */
  result: CloneResult;
}

/** film-dub-clone:previewRhythm 请求载荷 */
interface PreviewRhythmPayload {
  /** 参考视频路径 */
  videoPath: string;
}

/**
 * 注册影视解说克隆相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 启动影视解说克隆任务
   * payload: CloneParams
   * 返回: { taskId, result }
   */
  safeHandle(ipc, 'film-dub-clone:start', async (_event, payload: unknown) => {
    const params = payload as CloneParams;
    // 入参校验
    if (
      !params ||
      typeof params.referenceVideoPath !== 'string' ||
      params.referenceVideoPath.trim().length === 0
    ) {
      throw new Error('film-dub-clone:start 入参无效:referenceVideoPath 必填且不能为空');
    }
    if (typeof params.folderId !== 'string' || params.folderId.length === 0) {
      throw new Error('film-dub-clone:start 入参无效:folderId 必填(单文件夹隔离)');
    }

    // 构造 TaskItem 入队
    const taskId = `fdcl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskType: TaskType = 'film-dub-clone';
    const task: TaskItem = {
      id: taskId,
      type: taskType,
      title: '影视解说克隆',
      status: 'pending',
      progress: 0,
      params: params as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 创建 CancelToken(用 taskId 作为 token.id,便于 ffmpeg 进度推送关联)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    logger.info(`[IPC] film-dub-clone:start 任务 ${taskId} 已入队`);

    try {
      // 执行克隆(taskQueue 已自动把 pending 转 running)
      const result: CloneResult = await filmDubCloneService.runClone(params, taskId, token);
      // 标记完成
      taskQueue.complete(taskId, result.outputPath);
      activeTokens.delete(taskId);
      logger.info(
        `[IPC] film-dub-clone:start 任务 ${taskId} 完成: ${result.outputPath}`,
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
      logger.error(`[IPC] film-dub-clone:start 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
  });

  /**
   * 取消影视解说克隆任务
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'film-dub-clone:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('film-dub-clone:cancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消影视解说克隆任务');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] film-dub-clone:cancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });

  /**
   * 节奏预览(不入队,直接调用 extractRhythm 返回 RhythmPattern)
   * payload: { videoPath }
   * 返回: RhythmPattern
   *
   * 说明:使用临时 preview taskId,完成后清理 checkpoint,避免污染任务队列与磁盘。
   */
  safeHandle(ipc, 'film-dub-clone:previewRhythm', async (_event, payload: unknown) => {
    const p = payload as PreviewRhythmPayload;
    if (!p || typeof p.videoPath !== 'string' || p.videoPath.trim().length === 0) {
      throw new Error('film-dub-clone:previewRhythm 入参无效:videoPath 必填');
    }
    const previewTaskId = `fdcl-preview-${Date.now().toString(36)}`;
    const token = new CancelToken(previewTaskId);
    try {
      const rhythm: RhythmPattern = await extractRhythm(
        p.videoPath,
        taskQueue,
        previewTaskId,
        token,
      );
      return rhythm;
    } finally {
      // 清理预览产生的 checkpoint 文件(不入队,任务队列无对应 task,仅磁盘有 checkpoint)
      removeCheckpoint(previewTaskId);
    }
  });
}
