/**
 * AI 剪辑 IPC 注册
 *
 * 职责:将 aiEditService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   ai-edit:start           - 启动 AI 剪辑任务(入队 + 执行 + 完成/失败回调)
 *   ai-edit:cancel          - 取消 AI 剪辑任务(token.cancel + taskQueue.cancel)
 *   ai-edit:extractKeywords - 关键词预览(直接调用 llmService.extractKeywords)
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { aiEditService } from '../services/ai-edit';
import type { AiEditParams, AiEditResult, KeywordPreview } from '../services/ai-edit';
import { CancelToken, FFmpegError } from '../services/ffmpeg/types';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import type { TaskType } from '../../shared/types';
import { llmService } from '../services/llm';
import { logger } from '../utils/logger';

/**
 * 活跃任务的 CancelToken 映射:taskId → CancelToken
 * 用于 cancel 时找到对应令牌触发取消
 */
const activeTokens = new Map<string, CancelToken>();

/** ai-edit:start 返回结构 */
interface StartResp {
  /** 任务 ID */
  taskId: string;
  /** AI 剪辑结果 */
  result: AiEditResult | null;
}

/** ai-edit:extractKeywords 请求载荷 */
interface ExtractKeywordsPayload {
  /** 待抽取的文案 */
  text: string;
  /** 最大关键词数量(可选) */
  maxCount?: number;
}

/**
 * 执行 AI 剪辑并处理完成/失败/暂停三种结局
 * - 完成:taskQueue.complete + 返回 result
 * - 失败:taskQueue.fail + 抛出错误
 * - 暂停(用户主动):保留 paused 状态与 checkpoint,返回 null(不抛错)
 * @param taskId 任务 ID
 * @param params AI 剪辑参数
 * @param token 取消令牌
 * @param source 调用来源(start/resume),用于日志
 * @returns AI 剪辑结果;暂停时返回 null
 */
async function executeEdit(
  taskId: string,
  params: AiEditParams,
  token: CancelToken,
  source: 'start' | 'resume',
): Promise<AiEditResult | null> {
  try {
    const result = await aiEditService.runEdit(params, taskId, token);
    taskQueue.complete(taskId, result.outputPath);
    activeTokens.delete(taskId);
    logger.info(`[IPC] ai-edit:${source} 任务 ${taskId} 完成: ${result.outputPath}`);
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
      logger.info(
        `[IPC] ai-edit:${source} 任务 ${taskId} 已暂停(用户主动,checkpoint 保留)`,
      );
      return null;
    }

    logger.error(`[IPC] ai-edit:${source} 任务 ${taskId} 失败: ${msg}`);
    throw err;
  }
}

/**
 * 注册 AI 剪辑相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 启动 AI 剪辑任务
   * payload: AiEditParams
   * 返回: { taskId, result }
   */
  safeHandle(ipc, 'ai-edit:start', async (_event, payload: unknown) => {
    const params = payload as AiEditParams;
    // 入参校验
    if (!params || typeof params.script !== 'string' || params.script.trim().length === 0) {
      throw new Error('ai-edit:start 入参无效:script 必填且不能为空');
    }
    if (typeof params.folderId !== 'string' || params.folderId.length === 0) {
      throw new Error('ai-edit:start 入参无效:folderId 必填(单文件夹隔离)');
    }

    // 构造 TaskItem 入队
    const taskId = `aiedit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskType: TaskType = 'ai-edit';
    const task: TaskItem = {
      id: taskId,
      type: taskType,
      title: 'AI 剪辑',
      status: 'pending',
      progress: 0,
      params: params as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 创建 CancelToken(用 taskId 作为 token.id,便于 ffmpeg 进度推送关联)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    logger.info(`[IPC] ai-edit:start 任务 ${taskId} 已入队`);

    const result = await executeEdit(taskId, params, token, 'start');
    const resp: StartResp = { taskId, result };
    return resp;
  });

  /**
   * 取消 AI 剪辑任务
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'ai-edit:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-edit:cancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消 AI 剪辑任务');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] ai-edit:cancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });

  /**
   * 暂停 AI 剪辑任务
   * 先 taskQueue.pause(running→paused)再 token.cancel 终止 ffmpeg/推理。
   * runEdit 会抛 CANCELLED,executeEdit 检测 task.status==='paused' 后保留 checkpoint。
   * payload: { taskId }
   * 返回: { paused: taskId }
   */
  safeHandle(ipc, 'ai-edit:pause', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-edit:pause 入参缺失 taskId');
    }
    taskQueue.pause(taskId);
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户暂停 AI 剪辑任务');
    }
    logger.info(`[IPC] ai-edit:pause 任务 ${taskId} 已暂停(token.cancel 已触发)`);
    return { paused: taskId };
  });

  /**
   * 恢复 AI 剪辑任务(断点续渲染)
   * 从 taskQueue 取回原 params,新建 CancelToken,再次调 runEdit。
   * 合成阶段会 loadCheckpoint 跳过已完成步骤。
   * payload: { taskId }
   * 返回: { taskId, result } — result 为 null 表示再次被暂停
   */
  safeHandle(ipc, 'ai-edit:resume', async (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-edit:resume 入参缺失 taskId');
    }

    const task = taskQueue.get(taskId);
    if (!task) {
      throw new Error(`ai-edit:resume 任务不存在: ${taskId}`);
    }
    if (task.status !== 'paused') {
      throw new Error(`ai-edit:resume 任务非暂停状态(当前: ${task.status})`);
    }

    const params = task.params as unknown as AiEditParams;
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    taskQueue.resume(taskId);
    logger.info(`[IPC] ai-edit:resume 任务 ${taskId} 恢复执行(从 checkpoint 续渲染)`);

    const result = await executeEdit(taskId, params, token, 'resume');
    return { taskId, result };
  });

  /**
   * 关键词预览(直接调用 llmService.extractKeywords,不入队)
   * payload: { text, maxCount? }
   * 返回: KeywordPreview { keywords, raw }
   */
  safeHandle(ipc, 'ai-edit:extractKeywords', async (_event, payload: unknown) => {
    const p = payload as ExtractKeywordsPayload;
    if (!p || typeof p.text !== 'string' || p.text.trim().length === 0) {
      throw new Error('ai-edit:extractKeywords 入参无效:text 必填');
    }
    const result = await llmService.extractKeywords(p.text, p.maxCount);
    const preview: KeywordPreview = {
      keywords: result.keywords,
      raw: result.raw,
    };
    return preview;
  });
}
