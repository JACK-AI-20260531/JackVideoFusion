/**
 * 镜头构建纯函数
 * 职责:切换点→镜头列表、短镜头合并、时间基解析、场景分提取、均匀分段降级
 *      纯函数,不依赖 electron/ffprobe,可独立单元测试
 */
import type { Shot, DetectResult } from './types';

/** 首帧判定阈值(秒):早于此时间视为视频起点而非切换点 */
export const FIRST_FRAME_THRESHOLD = 0.05;

/**
 * 把数值限制在 [min, max] 区间
 * @param v 输入值
 * @param min 最小值(含)
 * @param max 最大值(含)
 * @returns 限定后的值
 */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 解析时间基字符串(如 "1/15360")为秒
 * @param tb 时间基字符串
 * @returns 时间基(秒),无法解析返回 0
 */
export function parseTimeBase(tb?: string): number {
  if (!tb) return 0;
  const parts = tb.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isNaN(num) && !isNaN(den) && den !== 0) {
      return num / den;
    }
  }
  const n = parseFloat(tb);
  return isNaN(n) ? 0 : n;
}

/**
 * 从帧的 side_data_list 中提取场景变化分数
 * select='gt(scene,X)' 过滤后的帧通常带 Scene Detection 类型的 side_data
 * @param sideDataList 帧的副数据列表(可为 undefined)
 * @returns 分数(0-1),无则 0
 */
export function extractSceneScore(
  sideDataList?: { side_data_type?: string; score?: number }[],
): number {
  if (!sideDataList) return 0;
  for (const item of sideDataList) {
    if (item.side_data_type === 'Scene Detection') {
      if (typeof item.score === 'number') return item.score;
    }
  }
  return 0;
}

/**
 * 把切换点序列转换为镜头列表
 * 第一个镜头起点固定为 0,最后一个镜头终点为 totalDuration
 * 切换点对应的分数归属给"以该点起点的镜头"
 * @param cutPoints 切换点时间数组(已排序)
 * @param scores 对应的场景分数数组
 * @param totalDuration 视频总时长
 * @returns 镜头数组
 */
export function buildShotsFromCuts(
  cutPoints: number[],
  scores: number[],
  totalDuration: number,
): Shot[] {
  const boundaries: number[] = [0, ...cutPoints, totalDuration];
  const shots: Shot[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end <= start) continue;
    // shot[i] 的起点 boundaries[i] 对应 cutPoints[i-1](i>=1 时),
    // 故 score 取 scores[i-1]
    const score = i > 0 && i - 1 < scores.length ? scores[i - 1] : undefined;
    shots.push({
      index: i,
      startTime: start,
      endTime: end,
      duration: end - start,
      score,
    });
  }
  return shots;
}

/**
 * 合并时长小于 minDuration 的镜头到前一个
 * 第一个镜头若过短且后续还有镜头,则把它合并到下一个
 * @param shots 原始镜头列表
 * @param minDuration 最小镜头时长
 * @returns 合并后的镜头列表
 */
export function mergeShortShots(shots: Shot[], minDuration: number): Shot[] {
  if (shots.length === 0) return [];
  const result: Shot[] = [];
  for (const shot of shots) {
    if (result.length === 0) {
      result.push({ ...shot });
      continue;
    }
    const last = result[result.length - 1];
    if (shot.duration < minDuration) {
      // 合并到上一个:扩展 endTime 与 duration,score 取较大值
      last.endTime = shot.endTime;
      last.duration = last.endTime - last.startTime;
      if (shot.score !== undefined) {
        last.score = Math.max(last.score ?? 0, shot.score);
      }
    } else {
      result.push({ ...shot });
    }
  }
  // 处理首镜头过短的情况:若合并后第一个镜头仍过短且后续有镜头,把它合到下一个
  if (result.length > 1 && result[0].duration < minDuration) {
    const first = result.shift()!;
    result[0].startTime = first.startTime;
    result[0].duration = result[0].endTime - result[0].startTime;
    if (first.score !== undefined) {
      result[0].score = Math.max(result[0].score ?? 0, first.score);
    }
  }
  return result;
}

/**
 * 降级:按 minDuration 等分总时长
 * 当 ffprobe scene 滤镜不可用或解析失败时使用
 * @param totalDuration 视频总时长
 * @param minDuration 单段时长(秒)
 * @returns 均匀分段的检测结果
 */
export function fallbackUniformSplit(totalDuration: number, minDuration: number): DetectResult {
  const segmentLen = Math.max(minDuration, 1.0);
  const count = Math.max(1, Math.floor(totalDuration / segmentLen));
  const per = totalDuration / count;
  const shots: Shot[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * per;
    const end = i === count - 1 ? totalDuration : (i + 1) * per;
    shots.push({
      index: i,
      startTime: start,
      endTime: end,
      duration: end - start,
    });
  }
  return {
    shots,
    totalDuration,
    shotCount: shots.length,
  };
}
