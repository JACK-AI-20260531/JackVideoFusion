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
  /** 来源模块(从消息前缀 [XXX] 推断,如 ffmpeg/tts/material/common) */
  module?: string;
}

/* ==================== Task 009 通用能力类型 ==================== */

/**
 * 分辨率预设
 */
export type ResolutionPreset = '720p' | '1080p' | '4k';

/**
 * 分辨率信息
 */
export interface ResolutionInfo {
  /** 预设标识 */
  preset: ResolutionPreset;
  /** 宽度(像素) */
  width: number;
  /** 高度(像素) */
  height: number;
  /** 显示标签 */
  label: string;
}

/**
 * 水印位置(九宫格,扩展自原 5 位置)
 * 命名采用 CSS 风格(垂直-水平),与 AppConfig.watermark.position 兼容
 */
export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * 水印配置(与 AppConfig.watermark 对齐并扩展)
 * 支持文本水印与图片水印,九宫格位置定位
 */
export interface WatermarkConfig {
  /** 是否启用水印 */
  enabled: boolean;
  /** 水印类型:text=文本水印,image=图片水印 */
  type: 'text' | 'image';
  /** 文本内容(type=text)或图片路径(type=image) */
  content: string;
  /** 水印位置(九宫格) */
  position: WatermarkPosition;
  /** 透明度 0-100 */
  opacity: number;
  /** 水平边距(像素) */
  marginX: number;
  /** 垂直边距(像素) */
  marginY: number;
  /** 文本水印字体大小,默认 24 */
  fontSize?: number;
  /** 文本水印字体颜色,默认 white */
  fontColor?: string;
  /** 文本水印自定义字体文件路径(.ttf) */
  fontFile?: string;
  /** 图片水印缩放比例(0-1),默认 1 */
  scale?: number;
}

/**
 * 字幕样式配置(与 AppConfig.subtitle 对齐并扩展)
 */
export interface SubtitleStyleConfig {
  /** 是否启用字幕 */
  enabled: boolean;
  /** 字体族 */
  fontFamily: string;
  /** 字体大小 */
  fontSize: number;
  /** 字体颜色(十六进制) */
  color: string;
  /** 是否启用描边 */
  outline: boolean;
  /** 是否启用阴影 */
  shadow: boolean;
  /** 对齐方式 */
  align: 'left' | 'center' | 'right';
}

/**
 * 导出路径配置
 */
export interface ExportPathConfig {
  /** 默认导出目录 */
  defaultExportDir: string;
  /** 默认分辨率预设 */
  defaultResolution: ResolutionPreset;
  /** 是否保留原画质 */
  keepOriginalQuality: boolean;
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
