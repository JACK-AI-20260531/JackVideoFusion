/**
 * 通用能力类型定义
 * 职责:重新导出共享类型,并提供主进程专用的类型转换工具
 *       (如 WatermarkPosition → ffmpeg WatermarkPosition 的映射)
 */
import type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  WatermarkPosition,
  SubtitleStyleConfig,
  ExportPathConfig,
} from '@shared/types';
import type { WatermarkPosition as FfmpegWatermarkPosition } from '../ffmpeg/types';

// 重新导出共享类型,供主进程模块统一引用
export type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  WatermarkPosition,
  SubtitleStyleConfig,
  ExportPathConfig,
};

/**
 * 九宫格位置 → ffmpeg WatermarkPosition 映射表
 * 将 CSS 风格命名(top-left)转换为 ffmpeg 风格命名(left-top)
 */
const FFMPEG_POSITION_MAP: Record<WatermarkPosition, FfmpegWatermarkPosition> = {
  'top-left': 'left-top',
  'top-center': 'center-top',
  'top-right': 'right-top',
  'middle-left': 'left-center',
  'center': 'center',
  'middle-right': 'right-center',
  'bottom-left': 'left-bottom',
  'bottom-center': 'center-bottom',
  'bottom-right': 'right-bottom',
};

/**
 * 将通用九宫格位置转换为 ffmpeg 滤镜所需的位置枚举
 * @param pos 通用九宫格位置(CSS 风格)
 * @returns ffmpeg WatermarkPosition 枚举值
 */
export function toFfmpegPosition(pos: WatermarkPosition): FfmpegWatermarkPosition {
  return FFMPEG_POSITION_MAP[pos] ?? 'right-bottom';
}
