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
  result: AiEditResult;
}

/** ai-edit:extractKeywords 请求载荷 */
interface ExtractKeywordsPayload {
  /** 待抽取的文案 */
  text: string;
  /** 最大关键词数量(可选) */
  maxCount?: number;
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

    try {
      // 执行 AI 剪辑(taskQueue 已自动把 pending 转 running)
      const result: AiEditResult = await aiEditService.runEdit(params, taskId, token);
      // 标记完成
      taskQueue.complete(taskId, result.outputPath);
      activeTokens.delete(taskId);
      logger.info(`[IPC] ai-edit:start 任务 ${taskId} 完成: ${result.outputPath}`);
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
      logger.error(`[IPC] ai-edit:start 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
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
