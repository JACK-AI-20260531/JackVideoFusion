/**
 * 文本即时间线 IPC 注册(PRD-文本即时间线 v2.0 M2)
 *
 * 通道列表:
 *   text-timeline:prepare  - 选定视频 → ASR 句级转写 + 初始 EDL(创建会话)
 *   text-timeline:applyOps - 应用编辑操作(cut/mute/move),返回会话快照
 *   text-timeline:undo     - 撤销
 *   text-timeline:redo     - 重做
 *   text-timeline:state    - 查询会话快照
 *
 * 快照结构:段落带 deleted 标记(与保留片段重叠 ≤50% 视为删除),
 * 渲染层据此划线灰显,预览 seek 直接使用原始素材时间。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { textTimelineService } from '../services/text-timeline/service';
import type { EditOp } from '../services/text-timeline/types';
import { CancelToken, FFmpegError } from '../services/ffmpeg/types';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import { logger } from '../utils/logger';

/**
 * 活跃导出任务的 CancelToken �射:taskId → CancelToken
 */
const activeTokens = new Map<string, CancelToken>();

/** 校验并提取 ops 数组(逐字段校验,非法即抛错) */
function parseOps(payload: unknown): EditOp[] {
  const { ops } = (payload ?? {}) as { ops?: unknown };
  if (!Array.isArray(ops)) throw new Error('text-timeline 入参无效:ops 必须为数组');
  for (const raw of ops) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.op !== 'string') throw new Error('text-timeline 入参无效:op 缺失');
    if (o.op === 'cut' || o.op === 'mute') {
      if (typeof o.start !== 'number' || typeof o.end !== 'number') {
        throw new Error('cut/mute 操作缺少数值区间 start/end');
      }
    } else if (o.op === 'move') {
      if (
        typeof o.srcStart !== 'number' ||
        typeof o.srcEnd !== 'number' ||
        typeof o.dstIndex !== 'number'
      ) {
        throw new Error('move 操作缺少 srcStart/srcEnd/dstIndex');
      }
    } else if (o.op !== 'retune') {
      throw new Error(`未知的编辑操作: ${String(o.op)}`);
    }
  }
  return ops as EditOp[];
}

/** 校验会话 ID(非法即抛错) */
function requireSessionId(payload: unknown, channel: string): string {
  const { sessionId } = (payload ?? {}) as { sessionId?: unknown };
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`${channel} 入参缺失 sessionId`);
  }
  return sessionId;
}

/**
 * 注册文本即时间线相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 创建会话:ASR 转写 + 初始 EDL
  safeHandle(ipc, 'text-timeline:prepare', async (_event, payload: unknown) => {
    const { videoPath } = (payload ?? {}) as { videoPath?: unknown };
    if (!videoPath || typeof videoPath !== 'string' || videoPath.trim().length === 0) {
      throw new Error('text-timeline:prepare 入参无效:缺少 videoPath');
    }
    return textTimelineService.prepare(videoPath);
  });

  // 应用编辑操作
  safeHandle(ipc, 'text-timeline:applyOps', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:applyOps');
    const ops = parseOps(payload);
    return textTimelineService.applyOps(sessionId, ops);
  });

  // 撤销
  safeHandle(ipc, 'text-timeline:undo', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:undo');
    return textTimelineService.undo(sessionId);
  });

  // 重做
  safeHandle(ipc, 'text-timeline:redo', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:redo');
    return textTimelineService.redo(sessionId);
  });

  // 一键清理口头禅(生成 cut 计划并应用)
  safeHandle(ipc, 'text-timeline:cleanup', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:cleanup');
    const { fillers } = (payload ?? {}) as { fillers?: unknown };
    if (fillers !== undefined && (!Array.isArray(fillers) || fillers.some((f) => typeof f !== 'string'))) {
      throw new Error('text-timeline:cleanup 入参无效:fillers 必须为字符串数组');
    }
    const result = textTimelineService.cleanupFillers(
      sessionId,
      fillers as string[] | undefined,
    );
    return result;
  });

  // 压缩停顿
  safeHandle(ipc, 'text-timeline:compressPauses', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:compressPauses');
    return textTimelineService.compressPauses(sessionId);
  });

  // 导出成片(入任务队列:进度可取消;逐段裁剪 + 无损拼接 + 一致性校验)
  safeHandle(ipc, 'text-timeline:export', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:export');
    const { outputDir, outputName } = (payload ?? {}) as {
      outputDir?: unknown;
      outputName?: unknown;
    };
    if (!outputDir || typeof outputDir !== 'string' || outputDir.trim().length === 0) {
      throw new Error('text-timeline:export 入参缺失 outputDir');
    }
    if (outputName !== undefined && typeof outputName !== 'string') {
      throw new Error('text-timeline:export 入参无效:outputName 必须为字符串');
    }
    if (
      typeof outputName === 'string' &&
      (outputName.includes('/') || outputName.includes('\\') || outputName.includes('..'))
    ) {
      throw new Error('text-timeline:export 入参无效:outputName 不能包含路径分隔符');
    }

    // 入队任务(任务中心透出进度,支持取消;taskId 由渲染层生成便于订阅进度)
    const { taskId: clientTaskId } = (payload ?? {}) as { taskId?: unknown };
    const taskId =
      typeof clientTaskId === 'string' && /^ttext-[a-z0-9-]{4,40}$/.test(clientTaskId)
        ? clientTaskId
        : `ttext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task: TaskItem = {
      id: taskId,
      type: 'text-timeline',
      title: '文本精剪导出',
      status: 'pending',
      progress: 0,
      params: { sessionId, outputDir, outputName },
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    try {
      const result = await textTimelineService.exportEdl(sessionId, outputDir, outputName, token, (percent) => {
        taskQueue.updateProgress(taskId, percent);
      });
      taskQueue.complete(taskId, result.outputPath);
      activeTokens.delete(taskId);
      logger.info(`[IPC] text-timeline:export 任务 ${taskId} 完成: ${result.outputPath}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
      const task = taskQueue.get(taskId);
      const isPaused = isCancelled && task && task.status === 'paused';
      if (!isCancelled && !isPaused) {
        taskQueue.fail(taskId, msg);
      }
      activeTokens.delete(taskId);
      logger.error(`[IPC] text-timeline:export 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
  });

  // 取消导出任务
  safeHandle(ipc, 'text-timeline:exportCancel', (_event, payload: unknown) => {
    const { taskId } = (payload ?? {}) as { taskId?: unknown };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('text-timeline:exportCancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消文本精剪导出');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] text-timeline:exportCancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });

  // 对话式编辑:指令 → LLM 结构化编辑计划
  safeHandle(ipc, 'text-timeline:planEdits', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:planEdits');
    const { instruction } = (payload ?? {}) as { instruction?: unknown };
    if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
      throw new Error('text-timeline:planEdits 入参缺失 instruction');
    }
    return textTimelineService.planEdits(sessionId, instruction);
  });

  // 应用已确认的编辑计划
  safeHandle(ipc, 'text-timeline:applyPlan', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:applyPlan');
    const { planId, indexes } = (payload ?? {}) as { planId?: unknown; indexes?: unknown };
    if (!planId || typeof planId !== 'string') {
      throw new Error('text-timeline:applyPlan 入参缺失 planId');
    }
    if (indexes !== undefined && !Array.isArray(indexes)) {
      throw new Error('text-timeline:applyPlan 入参无效:indexes 必须为数字数组');
    }
    return textTimelineService.applyPlan(sessionId, planId, indexes as number[] | undefined);
  });

  // 查询会话快照
  safeHandle(ipc, 'text-timeline:state', async (_event, payload: unknown) => {
    const sessionId = requireSessionId(payload, 'text-timeline:state');
    return textTimelineService.get(sessionId);
  });
}
