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
import { ffmpegService } from '@main/services/ffmpeg';
import { CancelToken } from '@main/services/ffmpeg/types';
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
    return ffmpegService.split(payload.input, payload.segmentSec, payload.outputDir, payload.opts, token);
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
}
