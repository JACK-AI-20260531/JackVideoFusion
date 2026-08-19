/**
 * FFmpeg IPC 注册
 *
 * 职责:将 ffmpegService 的原子方法注册为 'ffmpeg:*' 系列 IPC handler,
 *      并把返回值/异常统一包装成 { ok, data, error }。
 *
 * 集成方式:在 electron/ipc/index.ts 的 registrars 数组追加
 *   (ipc) => import('@main/ipc/ffmpeg.ipc').then(m => m.register(ipc))
 * 本文件只 export register,不修改任何既有入口。
 *
 * 取消流程:渲染层在调用长任务时自行生成 taskId 传入 payload,
 *         通过 window.api.on('ffmpeg:progress', ...) 监听进度,
 *         调用 'ffmpeg:cancel' 并传入同一 taskId 即可中断任务。
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { logger } from '@main/utils/logger';
import { ffmpegService } from '@main/services/ffmpeg';
import { resolveSplitOpts } from '@main/services/ffmpeg/split-options';
import { taskQueue, type TaskItem } from '@main/services/task-queue';
import { CancelToken, FFmpegError } from '@main/services/ffmpeg/types';
import {
  type SplitOpts,
  type ExtractFramesOpts,
  type ConcatOpts,
  type RemuxOpts,
  type TranscodeOpts,
  type WatermarkOpts,
  type BurnSubtitleOpts,
} from '@main/services/ffmpeg/types';

/**
 * IPC 通用响应结构(与 preload IpcResponse 对齐)
 */
interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 长任务通用 payload:携带可选 taskId 用于进度推送与取消
 */
interface TaskPayload {
  taskId?: string;
}

/** probe payload */
interface ProbePayload {
  filePath: string;
}
/** split payload */
interface SplitPayload extends TaskPayload {
  input: string;
  segmentSec: number;
  outputDir: string;
  opts?: SplitOpts;
  /** 界面级分割选项(拆分后由 resolveSplitOpts 归一化) */
  keepQuality?: boolean;
  stripAudio?: boolean;
  namingRule?: string;
  inputName?: string;
}
/** extractFrames payload */
interface ExtractFramesPayload extends TaskPayload {
  input: string;
  outputDir: string;
  opts?: ExtractFramesOpts;
}
/** concat payload */
interface ConcatPayload extends TaskPayload {
  inputs: string[];
  output: string;
  opts?: ConcatOpts;
}
/** remux payload */
interface RemuxPayload extends TaskPayload {
  input: string;
  output: string;
  opts: RemuxOpts;
}
/** transcode payload */
interface TranscodePayload extends TaskPayload {
  input: string;
  output: string;
  opts?: TranscodeOpts;
}
/** applyWatermark payload */
interface ApplyWatermarkPayload extends TaskPayload {
  input: string;
  output: string;
  opts: WatermarkOpts;
}
/** burnSubtitle payload */
interface BurnSubtitlePayload extends TaskPayload {
  input: string;
  output: string;
  opts: BurnSubtitleOpts;
}
/** stripAudio payload */
interface StripAudioPayload extends TaskPayload {
  input: string;
  output: string;
}
/** cancel payload */
interface CancelPayload {
  taskId: string;
}

/** 批量分割任务 payload(整批作为一个任务,支持暂停/恢复) */
interface SplitBatchPayload {
  taskId?: string;
  /** 待分割的输入文件列表 */
  inputs: string[];
  /** 每段时长(秒) */
  segmentSec: number;
  /** 输出目录 */
  outputDir: string;
  /** 界面级分割选项 */
  keepQuality?: boolean;
  stripAudio?: boolean;
  namingRule?: string;
}
/** 批量分割单个文件的输入项 */
interface SplitBatchItem {
  input: string;
  inputName: string;
}
/** 批量分割返回结果 */
interface SplitBatchResult {
  /** 全部成功产出的片段路径 */
  outputs: string[];
  /** 失败的文件: { input, error } */
  failed: { input: string; error: string }[];
}
/** pause/resume/cancel 请求载荷 */
interface SplitBatchTaskPayload {
  taskId: string;
}

// 活跃批量分割任务的取消令牌映射
const splitBatchTokens = new Map<string, CancelToken>();

/**
 * 批量分割任务内部参数
 */
interface SplitBatchRunParams {
  /** 待分割文件列表(含展示名) */
  items: SplitBatchItem[];
  /** 每段时长(秒) */
  segmentSec: number;
  /** 输出目录 */
  outputDir: string;
  /** 界面级分割选项(循环内按 file 的 inputName 重新解析命名规则) */
  keepQuality?: boolean;
  stripAudio?: boolean;
  namingRule?: string;
}

/**
 * 执行批量分割并处理完成/失败/暂停三种结局
 * - 逐文件调用 ffmpegService.split(原子),每文件完成后保存 checkpoint
 * - 暂停:保留已切完文件的 checkpoint,返回 null 供上层续传
 * - 普通文件失败:记录失败并继续处理后续文件
 * @param taskId 任务 ID
 * @param params 批量分割参数
 * @param token 取消令牌
 * @param source 调用来源(start/resume),用于日志
 * @returns 批量分割结果;执行中被用户暂停时返回 null
 */
async function executeSplitBatch(
  taskId: string,
  params: SplitBatchRunParams,
  token: CancelToken,
  source: 'start' | 'resume',
): Promise<SplitBatchResult | null> {
  const { items, segmentSec, outputDir, keepQuality, stripAudio, namingRule } = params;
  const outputs: string[] = [];
  const failed: { input: string; error: string }[] = [];
  const failedInputs = new Set<string>();

  // 尝试从 checkpoint 恢复已切完/已失败文件(断点续渲染)
  const cp = taskQueue.loadCheckpoint(taskId);
  if (cp && cp.step === 'ffmpeg-split-batch') {
    const ctx = cp.context as
      | { outputs?: string[]; failed?: { input: string; error: string }[] }
      | undefined;
    if (ctx?.outputs) outputs.push(...ctx.outputs);
    if (ctx?.failed) {
      failed.push(...ctx.failed);
      for (const f of ctx.failed) failedInputs.add(f.input);
    }
    logger.info(
      `[FFmpeg] splitBatch 任务 ${taskId} 命中 checkpoint,已完成 ${outputs.length} 个片段`,
    );
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // 已失败的文件跳过(避免重复报错)
    if (failedInputs.has(item.input)) continue;

    logger.info(
      `[FFmpeg] splitBatch:${source} 任务 ${taskId} 处理 ${i + 1}/${items.length}: ${item.input}`,
    );

    try {
      // 按该文件的 inputName 解析命名规则(opts),避免不同文件复用同一前缀
      const fileOpts = resolveSplitOpts({
        keepQuality,
        stripAudio,
        namingRule,
        inputName: item.inputName,
      });
      const segs = await ffmpegService.split(item.input, segmentSec, outputDir, fileOpts, token);
      outputs.push(...segs);
      failedInputs.delete(item.input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
      const task = taskQueue.get(taskId);
      const isPaused = isCancelled && task && task.status === 'paused';

      if (isPaused) {
        // 用户暂停:保存 checkpoint(含已完成/已失败文件),返回 null
        taskQueue.saveCheckpoint(taskId, 'ffmpeg-split-batch', Math.round((i / items.length) * 100), {
          outputs,
          failed,
        });
        logger.info(`[FFmpeg] splitBatch:${source} 任务 ${taskId} 已暂停(fileIndex=${i})`);
        return null;
      }
      if (isCancelled) {
        // 用户取消:不做失败记录,重新抛出
        throw err;
      }

      // 单个文件普通失败:记录并继续后续文件
      failed.push({ input: item.input, error: msg });
      failedInputs.add(item.input);
      taskQueue.saveCheckpoint(taskId, 'ffmpeg-split-batch', Math.round(((i + 1) / items.length) * 100), {
        outputs,
        failed,
      });
      continue;
    }

    // 每文件成功完成后保存 checkpoint,供 resume 续传
    taskQueue.saveCheckpoint(taskId, 'ffmpeg-split-batch', Math.round(((i + 1) / items.length) * 100), {
      outputs,
      failed,
    });
  }

  return { outputs, failed };
}

/**
 * 注册 ffmpeg:* 系列 IPC handler
 * 与 electron/ipc/index.ts 的 safeHandle 行为一致:
 *   成功返回 { ok: true, data },失败返回 { ok: false, error }
 * @param ipc ipcMain 引用(IpcMain 类型)
 */
export function register(ipc: IpcMain): void {
  /**
   * 包装 ipcMain.handle,统一异常处理与响应结构
   * @param channel IPC 频道名
   * @param handler 业务处理器(返回数据或抛异常)
   */
  const handle = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload: unknown) => Promise<T> | T,
  ): void => {
    ipc.handle(channel, async (event, payload) => {
      try {
        const data = await handler(event, payload);
        return { ok: true, data } satisfies IpcResponse<T>;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error } satisfies IpcResponse;
      }
    });
  };

  /**
   * 根据 payload 中的 taskId 构造取消令牌
   * @param payload 长任务 payload
   * @returns CancelToken(始终返回,即使无 taskId 也会生成)
   */
  const buildToken = (payload: TaskPayload): CancelToken => new CancelToken(payload.taskId);

  // 探测元数据
  handle('ffmpeg:probe', (_e, p) => {
    const { filePath } = p as ProbePayload;
    return ffmpegService.probe(filePath);
  });

  // 获取元数据(probe 别名)
  handle('ffmpeg:getMetadata', (_e, p) => {
    const { filePath } = p as ProbePayload;
    return ffmpegService.getMetadata(filePath);
  });

  // 仅获取时长
  handle('ffmpeg:getDuration', (_e, p) => {
    const { filePath } = p as ProbePayload;
    return ffmpegService.getDuration(filePath);
  });

  // 分割视频
  handle('ffmpeg:split', (_e, p) => {
    const payload = p as SplitPayload;
    const token = buildToken(payload);
    const uiOpts = {
      keepQuality: payload.keepQuality,
      stripAudio: payload.stripAudio,
      namingRule: payload.namingRule,
      inputName: payload.inputName,
    };
    const resolved = resolveSplitOpts(uiOpts);
    const opts: SplitOpts = { ...payload.opts, ...resolved };
    return ffmpegService.split(payload.input, payload.segmentSec, payload.outputDir, opts, token);
  });

  // 抽帧
  handle('ffmpeg:extractFrames', (_e, p) => {
    const payload = p as ExtractFramesPayload;
    const token = buildToken(payload);
    return ffmpegService.extractFrames(payload.input, payload.outputDir, payload.opts, token);
  });

  // 拼接多视频
  handle('ffmpeg:concat', (_e, p) => {
    const payload = p as ConcatPayload;
    const token = buildToken(payload);
    return ffmpegService.concat(payload.inputs, payload.output, payload.opts, token);
  });

  // 重封装
  handle('ffmpeg:remux', (_e, p) => {
    const payload = p as RemuxPayload;
    const token = buildToken(payload);
    return ffmpegService.remux(payload.input, payload.output, payload.opts, token);
  });

  // 转码
  handle('ffmpeg:transcode', (_e, p) => {
    const payload = p as TranscodePayload;
    const token = buildToken(payload);
    return ffmpegService.transcode(payload.input, payload.output, payload.opts, token);
  });

  // 添加水印
  handle('ffmpeg:applyWatermark', (_e, p) => {
    const payload = p as ApplyWatermarkPayload;
    const token = buildToken(payload);
    return ffmpegService.applyWatermark(payload.input, payload.output, payload.opts, token);
  });

  // 烧录字幕
  handle('ffmpeg:burnSubtitle', (_e, p) => {
    const payload = p as BurnSubtitlePayload;
    const token = buildToken(payload);
    return ffmpegService.burnSubtitle(payload.input, payload.output, payload.opts, token);
  });

  // 去除音轨
  handle('ffmpeg:stripAudio', (_e, p) => {
    const payload = p as StripAudioPayload;
    const token = buildToken(payload);
    return ffmpegService.stripAudio(payload.input, payload.output, token);
  });

  // 取消任务
  handle('ffmpeg:cancel', (_e, p) => {
    const { taskId } = p as CancelPayload;
    return ffmpegService.cancel(taskId);
  });

  // 检测二进制可用性
  handle('ffmpeg:detectBinaries', () => ffmpegService.detectBinaries());

  // ============ 批量分割(单一任务,支持暂停/恢复断点续渲染) ============

  /**
   * 开始整批素材分割
   * 将整批文件作为一个任务入 taskQueue,逐文件分割并保存 checkpoint。
   * 返回: { ok, data: { taskId, result } } — result 为 null 表示执行中被暂停
   */
  handle('ffmpeg:splitBatch', async (_e, p) => {
    const payload = p as SplitBatchPayload;
    if (!Array.isArray(payload.inputs) || payload.inputs.length === 0) {
      throw new Error('ffmpeg:splitBatch 入参 inputs 不能为空');
    }

    const items: SplitBatchItem[] = payload.inputs.map((input) => ({
      input,
      inputName: input.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'input',
    }));
    const batchParams: SplitBatchRunParams = {
      items,
      segmentSec: payload.segmentSec,
      outputDir: payload.outputDir,
      keepQuality: payload.keepQuality,
      stripAudio: payload.stripAudio,
      namingRule: payload.namingRule,
    };

    const taskId = `split-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: TaskItem = {
      id: taskId,
      type: 'material-split',
      title: `素材分割(${items.length} 个文件)`,
      status: 'pending',
      progress: 0,
      params: batchParams as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    const token = new CancelToken(taskId);
    splitBatchTokens.set(taskId, token);

    const result = await executeSplitBatch(taskId, batchParams, token, 'start');
    taskQueue.complete(taskId, result ? String(result.outputs.length) : undefined);
    return { taskId, result };
  });

  /**
   * 暂停整批素材分割
   * 先 taskQueue.pause 再 token.cancel,中断当前文件的分割子进程。
   * 返回: { ok, data: { paused: taskId } }
   */
  handle('ffmpeg:splitBatchPause', (_e, p) => {
    const { taskId } = p as SplitBatchTaskPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ffmpeg:splitBatchPause 入参缺失 taskId');
    }
    taskQueue.pause(taskId);
    const token = splitBatchTokens.get(taskId);
    if (token) token.cancel('用户暂停素材分割任务');
    return { paused: taskId };
  });

  /**
   * 恢复已暂停的整批素材分割
   * 从 taskQueue 取回原参数,新建 token,再次执行(loadCheckpoint 跳过已切完文件)。
   * 返回: { ok, data: { taskId, result } }
   */
  handle('ffmpeg:splitBatchResume', async (_e, p) => {
    const { taskId } = p as SplitBatchTaskPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ffmpeg:splitBatchResume 入参缺失 taskId');
    }

    const task = taskQueue.get(taskId);
    if (!task) throw new Error(`ffmpeg:splitBatchResume 任务不存在: ${taskId}`);
    if (task.status !== 'paused') {
      throw new Error(`ffmpeg:splitBatchResume 任务非暂停状态(当前: ${task.status})`);
    }

    const batchParams = task.params as unknown as SplitBatchRunParams;
    const token = new CancelToken(taskId);
    splitBatchTokens.set(taskId, token);
    taskQueue.resume(taskId);

    const result = await executeSplitBatch(taskId, batchParams, token, 'resume');
    taskQueue.complete(taskId, result ? String(result.outputs.length) : undefined);
    return { taskId, result };
  });

  /**
   * 取消整批素材分割(清除 checkpoint,不续渲染)
   * 返回: { ok, data: { cancelled: taskId } }
   */
  handle('ffmpeg:splitBatchCancel', (_e, p) => {
    const { taskId } = p as SplitBatchTaskPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('ffmpeg:splitBatchCancel 入参缺失 taskId');
    }
    const token = splitBatchTokens.get(taskId);
    if (token) {
      token.cancel('用户取消素材分割任务');
      splitBatchTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    return { cancelled: taskId };
  });
}
