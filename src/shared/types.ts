/**
 * 共享类型:IPC 通用响应结构(主/渲染层共用)
 */
export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 共享类型:任务状态枚举
 */
export type TaskStatus =
  | 'pending'    // 排队中
  | 'running'    // 执行中
  | 'paused'     // 已暂停
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'cancelled'; // 已取消

/**
 * 共享类型:任务类型(对应各功能模块)
 */
export type TaskType =
  | 'material-split'      // 素材分割
  | 'text-split'          // 文本分割
  | 'subtitle-extract'    // 字幕提取
  | 'tts-synthesize'      // TTS 合成
  | 'video-mix-random'    // 随机混剪
  | 'video-mix-audio'     // 文件夹音频匹配
  | 'ai-edit'             // AI 剪辑
  | 'ai-slice'            // AI 切片
  | 'film-dub-clone';     // 影视解说克隆

/**
 * 共享类型:日志条目
 */
export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  taskId?: string;
}

/**
 * 共享类型:素材文件类型
 */
export type MaterialKind = 'video' | 'audio' | 'text' | 'subtitle';

/**
 * 共享类型:文件夹素材元数据
 */
export interface MaterialMeta {
  id: string;
  folderId: string;
  path: string;
  name: string;
  kind: MaterialKind;
  durationSec?: number;
  sizeBytes?: number;
  createdAt: string;
}
