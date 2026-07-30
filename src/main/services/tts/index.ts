/**
 * TTS 服务统一导出
 * 职责:聚合对外暴露的类型与单例
 */

export { ttsService } from './tts-service';
export { EdgeTtsEngine } from './edge-tts-engine';
export { splitLongText, isWithinCharLimit, DEFAULT_MAX_CHARS } from './text-splitter';
export {
  formatSrtTime,
  buildSrtEntries,
  serializeSrt,
  generateSrtContent,
} from './srt-generator';
export type { TextChunk } from './text-splitter';
export type { SrtEntry } from './srt-generator';
export type { ProsodyParams, EngineSynthesisOutput } from './edge-tts-engine';
export type {
  VoiceInfo,
  VoiceGender,
  TtsParams,
  TtsResult,
  TtsService,
  TtsProgressPayload,
  ChunkSynthesisResult,
} from './types';
