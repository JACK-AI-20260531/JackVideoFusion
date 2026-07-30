/**
 * 分辨率预设服务
 * 职责:提供 720P/1080P/4K 预设常量与 ffmpeg scale/pad 滤镜字符串生成
 */
import type { ResolutionPreset, ResolutionInfo } from '@shared/types';

/**
 * 分辨率预设常量表
 * 720P=1280x720, 1080P=1920x1080, 4K=3840x2160
 */
export const RESOLUTION_PRESETS: ResolutionInfo[] = [
  { preset: '720p', width: 1280, height: 720, label: '720P (1280×720)' },
  { preset: '1080p', width: 1920, height: 1080, label: '1080P (1920×1080)' },
  { preset: '4k', width: 3840, height: 2160, label: '4K (3840×2160)' },
];

/**
 * 根据预设标识获取分辨率信息
 * @param preset 预设标识(720p/1080p/4k)
 * @returns 分辨率信息;未知预设回退到 1080p
 */
export function getResolution(preset: ResolutionPreset): ResolutionInfo {
  return RESOLUTION_PRESETS.find((r) => r.preset === preset) ?? RESOLUTION_PRESETS[1];
}

/**
 * 构建 ffmpeg scale+pad 滤镜字符串,统一画面比例
 * 先等比缩小到目标尺寸(decrease 模式),再 pad 居中填充黑边
 * @param preset 目标分辨率预设
 * @param keepOriginal 是否保留原画质(为 true 时返回空字符串,不做缩放)
 * @returns ffmpeg 滤镜字符串,如 "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
 */
export function buildScaleFilter(preset: ResolutionPreset, keepOriginal: boolean): string {
  if (keepOriginal) return '';
  const info = getResolution(preset);
  return `scale=${info.width}:${info.height}:force_original_aspect_ratio=decrease,pad=${info.width}:${info.height}:(ow-iw)/2:(oh-ih)/2`;
}
