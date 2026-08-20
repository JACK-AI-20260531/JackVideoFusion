/**
 * OCR 抽帧间隔解析(纯函数)
 *
 * 职责:根据视频时长、请求间隔与最大抽帧上限,决定实际抽帧间隔。
 * 当按请求间隔计算的帧数超过上限时,自动增大间隔以控制总帧数,
 * 防止超长视频 OCR 抽帧过多导致耗时爆炸。
 */

/** 默认抽帧间隔(秒) */
const DEFAULT_INTERVAL = 1;
/** 默认最大抽帧上限 */
const DEFAULT_MAX_FRAMES = 600;

/**
 * 解析实际抽帧间隔
 * @param durationSec 视频时长(秒)
 * @param requestInterval 请求的抽帧间隔(秒);<=0 时用默认 1
 * @param maxFrames 最大抽帧上限;<=0 时用默认 600
 * @returns 实际抽帧间隔(秒)
 */
export function resolveFrameInterval(
  durationSec: number,
  requestInterval?: number,
  maxFrames?: number,
): number {
  const cap = maxFrames && maxFrames > 0 ? maxFrames : DEFAULT_MAX_FRAMES;
  if (durationSec <= 0 || cap <= 0) {
    return DEFAULT_INTERVAL;
  }
  const interval = requestInterval && requestInterval > 0 ? requestInterval : DEFAULT_INTERVAL;
  const rawFrames = Math.ceil(durationSec / interval);
  if (rawFrames > cap) {
    // 超上限:整体拉大间隔,使总帧数不超过 cap
    return Math.max(interval, durationSec / cap);
  }
  return interval;
}
