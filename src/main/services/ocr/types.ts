/**
 * OCR 字幕识别服务类型定义
 *
 * 职责:声明画面文字识别(OCR)到字幕提取的对外/对内数据结构,包括:
 *   - OCR 识别参数(OcrParams)
 *   - 单帧识别结果(FrameOcrResult)
 *   - 字幕行(SubtitleLine)
 *   - 进度回调(OcrProgressCallback)
 *
 * 设计约定:
 *   - 采用 Tesseract.js(WASM)英文/中文识别,本地推理,无需上传画面
 *   - 抽帧复用 ffmpegService.extractFrames,对象路径由本服务管理
 *   - 纯合并逻辑(srt-builder.ts)与引擎(engine.ts)分离,便于独立单元测试
 */
import type { CancelToken } from '../ffmpeg/types';

/** 支持的 OCR 语言(可扩展 Tesseract 语言代码) */
export type OcrLang = 'chi_sim' | 'eng';

/**
 * OCR 字幕提取参数
 */
export interface OcrParams {
  /** 视频文件绝对路径 */
  videoPath: string;
  /** 输出 SRT 文件绝对路径 */
  outputPath: string;
  /** 抽帧间隔(秒),默认 1;越大越省时但字幕时间轴越粗 */
  intervalSec?: number;
  /** OCR 语言,默认 chi_sim(简体中文) */
  lang?: OcrLang;
  /** 抽帧缩放宽度(px),用于加速识别,默认 1280 */
  frameWidth?: number;
  /** 最短字幕持续时间(秒),默认 1;过短的字幕会被丢弃 */
  minDurationSec?: number;
  /** 帧间文本相似阈值(0-1),默认 0.6;用于合并连续相同字幕 */
  similarityThreshold?: number;
}

/**
 * 单帧 OCR 识别结果
 */
export interface FrameOcrResult {
  /** 该帧对应的视频时间点(秒) */
  timeSec: number;
  /** 识别出的文本(去空白后) */
  text: string;
}

/**
 * 一条字幕(时间轴 + 文本)
 */
export interface SubtitleLine {
  /** 开始时间(秒) */
  startSec: number;
  /** 结束时间(秒) */
  endSec: number;
  /** 字幕文本 */
  text: string;
}

/**
 * OCR 进度回调(按阶段反馈,0-1)
 */
export type OcrProgressCallback = (progress: number, phase: string) => void;

/**
 * OCR 服务完整选项(参数 + 可选取消令牌)
 */
export interface OcrRequest {
  /** 识别参数 */
  params: OcrParams;
  /** 取消令牌(可选) */
  token?: CancelToken;
  /** 进度回调(可选) */
  onProgress?: OcrProgressCallback;
}
