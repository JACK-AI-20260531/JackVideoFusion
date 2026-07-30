/**
 * 通用能力服务模块入口
 * 职责:统一导出分辨率、路径、日志广播等通用服务,供 IPC 层与上层模块调用
 */

// 类型与转换工具
export {
  toFfmpegPosition,
} from './types';
export type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  WatermarkPosition,
  SubtitleStyleConfig,
  ExportPathConfig,
} from './types';

// 分辨率预设
export {
  RESOLUTION_PRESETS,
  getResolution,
  buildScaleFilter,
} from './resolutions';

// 导出路径
export {
  getDefaultExportDir,
  resolveExportPath,
} from './paths';

// 日志广播
export {
  broadcastLog,
} from './log-broadcaster';
