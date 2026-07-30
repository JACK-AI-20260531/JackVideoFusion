/**
 * TTS 服务类型定义
 * 职责:声明音色、合成参数、合成结果、服务接口的统一形状
 */

/** 音色性别分类 */
export type VoiceGender = 'Male' | 'Female';

/** 音色元数据(对外裁剪后的字段) */
export interface VoiceInfo {
  /** 完整音色名,如"Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)" */
  name: string;
  /** 短名,如"zh-CN-XiaoxiaoNeural",作为合成时的 voice 入参 */
  shortName: string;
  /** 性别:Male / Female */
  gender: VoiceGender;
  /** 区域,如"zh-CN" */
  locale: string;
}

/** TTS 合成参数 */
export interface TtsParams {
  /** 待合成文本,可长达 5W 字符 */
  text: string;
  /** 音色短名,默认 zh-CN-XiaoxiaoNeural */
  voice?: string;
  /** 语速,百分比 -100 ~ 100,默认 0(正数加快、负数减慢) */
  rate?: number;
  /** 音量,百分比 -100 ~ 100,默认 0 */
  volume?: number;
  /** 音调,百分比 -100 ~ 100,默认 0 */
  pitch?: number;
  /** 输出 mp3 路径(必须) */
  outputPath: string;
  /** 输出 srt 路径(可选,不传则不生成字幕) */
  srtPath?: string;
}

/** TTS 合成结果 */
export interface TtsResult {
  /** 最终生成的 mp3 文件路径 */
  audioPath: string;
  /** 当传入 srtPath 时,生成的 srt 文件路径 */
  srtPath?: string;
  /** 合成音频总时长,单位秒 */
  durationSec: number;
  /** 已合成字符数(用于校验是否截断) */
  charCount: number;
}

/** 进度推送事件载荷 */
export interface TtsProgressPayload {
  /** 当前已完成分片序号(1-based) */
  current: number;
  /** 总分片数 */
  total: number;
  /** 当前合成阶段:'splitting' | 'synthesizing' | 'merging' | 'done' */
  stage: 'splitting' | 'synthesizing' | 'merging' | 'done';
  /** 当前批次的索引(单次合成为 0) */
  batchIndex?: number;
  /** 批次总数 */
  batchTotal?: number;
}

/** TTS 服务接口契约 */
export interface TtsService {
  /** 列出微软 Edge 可用音色(按 locale 过滤可选) */
  listVoices(locale?: string): Promise<VoiceInfo[]>;
  /** 单次合成:支持 5W 字符超长文本 */
  synthesize(params: TtsParams): Promise<TtsResult>;
  /** 批量合成:多段文本一次性排队输出 */
  synthesizeBatch(items: TtsParams[]): Promise<TtsResult[]>;
}

/** 内部用:单个文本分片的合成产物 */
export interface ChunkSynthesisResult {
  /** 该分片的 mp3 二进制数据 */
  buffer: Buffer;
  /** 该分片对应的文本(已去除空白) */
  text: string;
  /** 该分片估算的音频时长(秒) */
  durationSec: number;
  /** 该分片在原文中的起始字符偏移 */
  offset: number;
}
