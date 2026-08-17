/**
 * FFmpeg 服务类型定义
 * 集中声明所有 ffmpeg 服务相关的接口、选项、结果类型、错误与取消令牌。
 * 主进程服务层与 IPC 层共享这些类型。
 */

import type { SubtitleStreamInfo } from './subtitle-stream';

/**
 * 视频元数据(探测结果)
 */
export interface VideoMeta {
  /** 文件绝对路径 */
  filePath: string;
  /** 时长(秒) */
  durationSec: number;
  /** 视频宽度 */
  width?: number;
  /** 视频高度 */
  height?: number;
  /** 视频编码器,如 h264 */
  videoCodec?: string;
  /** 音频编码器,如 aac */
  audioCodec?: string;
  /** 帧率 */
  fps?: number;
  /** 总比特率(bps) */
  bitrate?: number;
  /** 文件大小(字节) */
  sizeBytes?: number;
  /** 容器格式,如 mp4,mov */
  format?: string;
  /** 内嵌字幕流信息 */
  subtitleStreams?: SubtitleStreamInfo[];
}

/**
 * 分割选项
 */
export interface SplitOpts {
  /** 输出文件名前缀,默认 segment_ */
  prefix?: string;
  /** 输出文件扩展名(不含点),默认 mp4 */
  ext?: string;
  /** 是否精确分割(重编码,慢但精确);默认 false 走关键帧快速分割 */
  precise?: boolean;
  /** 是否去除原声(分割结果不含音轨),默认 false */
  stripAudio?: boolean;
}

/**
 * 抽帧模式
 * - fps:每秒抽 N 帧
 * - interval:每 N 秒抽一帧
 * - count:全片均匀抽取 N 帧(需读取时长)
 */
export type ExtractFramesMode = 'fps' | 'interval' | 'count';

/**
 * 抽帧选项
 */
export interface ExtractFramesOpts {
  /** 抽帧模式,默认 fps */
  mode?: ExtractFramesMode;
  /** 与 mode 配合的数值;默认 1 */
  value?: number;
  /** 输出文件名前缀,默认 frame_ */
  prefix?: string;
  /** 输出图片格式,默认 jpg */
  format?: 'jpg' | 'png' | 'webp';
  /** 输出宽度(等比缩放),可选 */
  width?: number;
}

/**
 * 拼接模式
 * - demuxer:concat 分离器,无需重编码,速度快,要求同源同编码
 * - filter:concat 滤镜,需重编码,兼容异源
 */
export type ConcatMode = 'demuxer' | 'filter';

/**
 * xfade 转场类型(取自 ffmpeg xfade 滤镜 transition 参数)
 * - fade:淡入淡出(默认)
 * - wipeleft/wiperight/wipeup/wipedown:方向擦除
 * - slideleft/slideright/slideup/slidedown:方向滑入
 * - circleopen/circleclose:圆形开/关
 * - dissolve:溶解
 * 详见 https://ffmpeg.org/ffmpeg-filters.html#xfade
 */
export type XfadeTransition =
  | 'fade'
  | 'wipeleft'
  | 'wiperight'
  | 'wipeup'
  | 'wipedown'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'circleopen'
  | 'circleclose'
  | 'dissolve';

/**
 * 拼接选项
 */
export interface ConcatOpts {
  /** 拼接模式,默认 demuxer */
  mode?: ConcatMode;
  /**
   * 转场淡化时长(秒),>0 时启用 xfade 链式转场
   * 仅 mode='filter' 时生效;demuxer 模式下会被忽略并打印警告
   * 默认 0=无转场
   */
  transitionSec?: number;
  /**
   * 转场类型,默认 'fade'(淡入淡出)
   * 仅 transitionSec>0 时生效
   */
  transition?: XfadeTransition;
}

/**
 * 重封装选项(仅更换容器,不重编码)
 */
export interface RemuxOpts {
  /** 目标容器格式,如 mp4 / mkv / mov */
  format: string;
}

/**
 * 转码选项
 */
export interface TranscodeOpts {
  /** 视频编码器,默认 libx264 */
  videoCodec?: string;
  /** 音频编码器,默认 aac */
  audioCodec?: string;
  /** 视频码率,如 '2M' */
  videoBitrate?: string;
  /** 音频码率,如 '128k' */
  audioBitrate?: string;
  /** 分辨率,如 '1280x720' */
  resolution?: string;
  /** 帧率,如 30 */
  fps?: number;
  /** 编码预设,如 ultrafast / fast / medium / slow */
  preset?: string;
  /** 输出容器格式 */
  format?: string;
  /** 透传给 fluent-ffmpeg 的额外输出选项 */
  extraOutputOptions?: string[];
}

/**
 * 水印类型
 */
export type WatermarkType = 'image' | 'text';

/**
 * 水印位置枚举
 */
export type WatermarkPosition =
  | 'left-top'
  | 'left-center'
  | 'left-bottom'
  | 'center-top'
  | 'center'
  | 'center-bottom'
  | 'right-top'
  | 'right-center'
  | 'right-bottom';

/**
 * 水印选项(支持图片水印与文本水印)
 */
export interface WatermarkOpts {
  /** 水印类型 */
  type: WatermarkType;
  /** 图片水印路径(type=image 时必填) */
  image?: string;
  /** 文本水印内容(type=text 时必填) */
  text?: string;
  /** 水印位置,默认 right-bottom */
  position?: WatermarkPosition;
  /** 水平边距(像素),默认 20 */
  marginX?: number;
  /** 垂直边距(像素),默认 20 */
  marginY?: number;
  /** 图片水印缩放比例(0-1),默认 1(原图) */
  scale?: number;
  /** 文本水印字体文件路径,可选 */
  fontFile?: string;
  /** 文本水印字体大小,默认 24 */
  fontSize?: number;
  /** 文本水印字体颜色,默认 white */
  fontColor?: string;
}

/**
 * 字幕烧录选项
 */
export interface BurnSubtitleOpts {
  /** 字幕文件路径(srt / ass) */
  subtitlePath: string;
  /** 字体大小(ass 样式优先),默认 24 */
  fontSize?: number;
  /** 是否强制覆盖字幕样式,默认 false */
  forceStyle?: boolean;
}

/**
 * 进度信息(推送给渲染层)
 */
export interface FFmpegProgress {
  /** 任务 ID(与 CancelToken.id 对应) */
  taskId: string;
  /** 当前阶段,如 probe / split / extractFrames / concat / transcode */
  stage: string;
  /** 进度百分比 0-100;无法计算时为 0 */
  percent: number;
  /** ffmpeg 时间标记,如 00:01:23.45 */
  timemark?: string;
  /** 输入文件路径 */
  input?: string;
  /** 输出文件路径 */
  output?: string;
}

/**
 * FFmpeg 错误类型
 * 统一携带错误码、stderr 摘要与任务 ID,便于上层定位
 */
export class FFmpegError extends Error {
  /** 错误码 */
  readonly code: string;
  /** ffmpeg 原始 stderr 输出 */
  readonly stderr?: string;
  /** stderr 摘要(末尾若干行) */
  readonly stderrSummary?: string;
  /** 关联的任务 ID */
  readonly taskId?: string;

  constructor(
    message: string,
    opts?: { code?: string; stderr?: string; taskId?: string },
  ) {
    super(message);
    this.name = 'FFmpegError';
    this.code = opts?.code ?? 'FFMPEG_ERROR';
    this.stderr = opts?.stderr ?? undefined;
    this.stderrSummary = extractStderrSummary(opts?.stderr);
    this.taskId = opts?.taskId;
  }
}

/**
 * 从 ffmpeg stderr 中提取末尾摘要(最多 5 行),便于错误展示
 * @param stderr ffmpeg 原始 stderr
 * @returns 摘要文本,无内容时返回 undefined
 */
function extractStderrSummary(stderr?: string): string | undefined {
  if (!stderr) return undefined;
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-5).join('\n').trim();
  return tail.length > 0 ? tail : undefined;
}

/**
 * 取消令牌
 * 调用方创建后传入服务方法,外部调用 cancel() 即可中断对应的 ffmpeg 子进程。
 * token.id 同时作为任务 ID 用于进度推送与取消定位。
 */
export class CancelToken {
  /** 唯一 ID */
  readonly id: string;
  /** 是否已取消 */
  cancelled = false;
  /** 取消原因 */
  reason?: string;

  constructor(id?: string) {
    this.id = id ?? generateTaskId();
  }

  /**
   * 触发取消
   * @param reason 取消原因
   */
  cancel(reason?: string): void {
    this.cancelled = true;
    this.reason = reason ?? '用户取消任务';
  }
}

/**
 * 生成简易任务 ID(时间戳 + 随机串)
 * @returns 任务 ID 字符串
 */
export function generateTaskId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}
