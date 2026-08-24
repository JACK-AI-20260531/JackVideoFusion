/**
 * ASR 语音转写字幕服务类型定义
 *
 * 职责:声明语音识别(ASR)到字幕提取的对外/对内数据结构,包括:
 *   - ASR 识别参数(AsrParams)
 *   - 识别出的时间轴片段(AsrSegment)
 *   - 进度回调(AsrProgressCallback)
 *
 * 设计约定:
 *   - 基于 @huggingface/transformers 的 Whisper ONNX 本地推理,不依赖云端
 *   - 音频预处理复用 ffmpegService.extractAudio(16k mono wav),或 read_audio 直接读取
 *   - 与 OCR 字幕提取(ocr/)同构,便于渲染层统一复用「字幕提取」页面
 */
import type { CancelToken } from '../ffmpeg/types';

/** 支持的语言(Whisper language code;留空则自动检测) */
export type AsrLang =
  | 'zh' // 中文
  | 'en' // 英文
  | 'ja' // 日文
  | 'ko' // 韩文
  | 'auto'; // 自动检测

/** 可选 Whisper 模型规格(体积/精度/速度权衡) */
export type AsrModelSize = 'base' | 'small' | 'medium';

/**
 * ASR 语音转写字幕参数
 */
export interface AsrParams {
  /** 视频/音频文件绝对路径 */
  videoPath: string;
  /** 输出 SRT 文件绝对路径 */
  outputPath: string;
  /** 语言,默认 auto(自动检测) */
  lang?: AsrLang;
  /** 模型规格,默认 base */
  modelSize?: AsrModelSize;
  /** 会话标识(可选,用于把进度事件关联回渲染层的某次识别请求) */
  requestId?: string;
}

/**
 * 识别出的时间轴片段
 */
export interface AsrSegment {
  /** 开始时间(秒) */
  startSec: number;
  /** 结束时间(秒) */
  endSec: number;
  /** 识别文本(清洗后) */
  text: string;
}

/**
 * ASR 进度回调(按阶段反馈,0-1)
 */
export type AsrProgressCallback = (progress: number, phase: string) => void;

/**
 * ASR 服务完整选项(参数 + 可选取消令牌)
 */
export interface AsrRequest {
  /** 识别参数 */
  params: AsrParams;
  /** 取消令牌(可选) */
  token?: CancelToken;
  /** 进度回调(可选) */
  onProgress?: AsrProgressCallback;
}
