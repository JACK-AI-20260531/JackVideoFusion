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
import { viralityScorer } from '../services/ai-slice/virality-service';
import type { ViralityScoreClipInput } from '../services/ai-slice/virality-service';
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
  result: AiSliceResult | null;
}

/**
 * 执行 AI 切片并处理完成/失败/暂停三种结局
 * - 完成:taskQueue.complete + 返回 result
 * - 失败:taskQueue.fail + 抛出错误
 * - 暂停(用户主动):保留 paused 状态与 checkpoint,返回 null(不抛错)
 * @param taskId 任务 ID
 * @param params AI 切片参数
 * @param token 取消令牌
 * @param source 调用来源(start/resume),用于日志
 * @returns AI 切片结果;暂停时返回 null
 */
async function executeSlice(
  taskId: string,
  params: AiSliceParams,
  token: CancelToken,
  source: 'start' | 'resume',
): Promise<AiSliceResult | null> {
  try {
    const result = await aiSliceService.runSlice(params, taskId, token);
    taskQueue.complete(taskId);
    activeTokens.delete(taskId);
    logger.info(
      `[IPC] ai-slice:${source} 任务 ${taskId} 完成: ${result.totalClips} 个切片`,
    );
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
        `[IPC] ai-slice:${source} 任务 ${taskId} 已暂停(用户主动,checkpoint 保留)`,
      );
      return null;
    }

    logger.error(`[IPC] ai-slice:${source} 任务 ${taskId} 失败: ${msg}`);
    throw err;
  }
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

    const result = await executeSlice(taskId, params, token, 'start');
    const resp: StartResp = { taskId, result };
    return resp;
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

  /**
   * 暂停 AI 切片任务
   * 先 taskQueue.pause(running→paused)再 token.cancel 终止 ffmpeg/推理。
   * runSlice 会抛 CANCELLED,executeSlice 检测 task.status==='paused' 后保留 checkpoint。
   * payload: { taskId }
   * 返回: { paused: taskId }
   */
  safeHandle(ipc, 'ai-slice:pause', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-slice:pause 入参缺失 taskId');
    }
    taskQueue.pause(taskId);
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户暂停 AI 切片任务');
    }
    logger.info(`[IPC] ai-slice:pause 任务 ${taskId} 已暂停(token.cancel 已触发)`);
    return { paused: taskId };
  });

  /**
   * 恢复 AI 切片任务(断点续渲染)
   * 从 taskQueue 取回原 params,新建 CancelToken,再次调 runSlice。
   * 通过 checkpoint 跳过已完成阶段(probe/detect 与已导出的切片)。
   * payload: { taskId }
   * 返回: { taskId, result } — result 为 null 表示再次被暂停
   */
  safeHandle(ipc, 'ai-slice:resume', async (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ai-slice:resume 入参缺失 taskId');
    }

    const task = taskQueue.get(taskId);
    if (!task) {
      throw new Error(`ai-slice:resume 任务不存在: ${taskId}`);
    }
    if (task.status !== 'paused') {
      throw new Error(`ai-slice:resume 任务非暂停状态(当前: ${task.status})`);
    }

    const params = task.params as unknown as AiSliceParams;
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    taskQueue.resume(taskId);
    logger.info(`[IPC] ai-slice:resume 任务 ${taskId} 恢复执行(从 checkpoint 续渲染)`);

    const result = await executeSlice(taskId, params, token, 'resume');
    return { taskId, result };
  });

  /**
   * 爆款评分(智能评分)
   * 对已生成的切片列表执行:ASR 转写(尽力而为)→ LLM 批量评分 → 失败降级基础评分
   * payload: ViralityScoreClipInput[]
   * 返回: { reports: Record<index, ViralityReport>, source: 'llm' | 'heuristic' }
   */
  safeHandle(ipc, 'ai-slice:scoreVirality', async (_event, payload: unknown) => {
    const clips = payload as ViralityScoreClipInput[];
    if (!Array.isArray(clips) || clips.length === 0) {
      throw new Error('ai-slice:scoreVirality 入参无效:clips 不能为空');
    }
    for (const clip of clips) {
      if (
        !clip ||
        typeof clip.index !== 'number' ||
        !Number.isInteger(clip.index) ||
        clip.index < 1 ||
        typeof clip.outputPath !== 'string' ||
        clip.outputPath.trim().length === 0 ||
        typeof clip.duration !== 'number' ||
        typeof clip.excitementScore !== 'number'
      ) {
        throw new Error(
          'ai-slice:scoreVirality 入参无效:index/outputPath/duration/excitementScore 必填且类型正确',
        );
      }
    }
    const result = await viralityScorer.score(clips);
    logger.info(
      `[IPC] ai-slice:scoreVirality 完成: ${Object.keys(result.reports).length} 条评分(source=${result.source})`,
    );
    return result;
  });

  /**
   * 查询当前生效的五维权重(数据飞轮自学习产物,PRD-v1.7 FR-3)
   * 返回: { weights, defaultWeights }
   */
  safeHandle(ipc, 'ai-slice:viralityWeights', async () => {
    return viralityScorer.getWeights();
  });

  /**
   * 执行权重自学习校准(评分历史 × 发布数据)
   * 返回: { weights, learned, sampleCount, persisted }
   */
  safeHandle(ipc, 'ai-slice:calibrateWeights', async () => {
    const result = await viralityScorer.calibrateFromData();
    logger.info(
      `[IPC] ai-slice:calibrateWeights learned=${result.learned} samples=${result.sampleCount}`,
    );
    return result;
  });

  /**
   * 重置五维权重为默认值
   * 返回: { reset: boolean }
   */
  safeHandle(ipc, 'ai-slice:resetViralityWeights', async () => {
    const ok = await viralityScorer.resetWeights();
    return { reset: ok };
  });
}
