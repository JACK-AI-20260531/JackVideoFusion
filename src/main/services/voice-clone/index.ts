/**
 * 语音克隆服务统一导出
 *
 * 职责:聚合对外暴露的类型、单例与子模块
 *       供 IPC 层与其他服务模块统一引用
 */

export { voiceCloneService } from './voice-clone-service';
export { voiceLibrary } from './voice-library';
export { gptSoVitsClient } from './gpt-sovits-client';
export { serviceManager } from './service-manager';
export type { VoiceCloneProgressPayload } from './voice-clone-service';

export type {
  CloneLanguage,
  ClonedVoice,
  VoiceLibraryMeta,
  CloneSampleParams,
  CloneSynthParams,
  CloneSynthResult,
  GptSoVitsStatus,
  GptSoVitsConfig,
} from './types';
