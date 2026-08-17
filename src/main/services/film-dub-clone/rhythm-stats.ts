/**
 * 节奏统计纯函数
 * 职责:由镜头序列计算平均时长、剪辑点数等统计量
 *      纯函数,不依赖 electron/shotDetectService,可独立单元测试
 */
import type { Shot } from '../shot-detect';

/** 节奏统计结果 */
export interface RhythmStats {
  /** 镜头总数 */
  shotCount: number;
  /** 平均镜头时长(秒);无镜头时为 0 */
  avgShotDuration: number;
  /** 剪辑点数 = 镜头数 - 1(N 个镜头间有 N-1 个切换点),最小 0 */
  cutCount: number;
}

/**
 * 由镜头序列计算节奏统计量
 * @param shots 镜头列表(含 duration)
 * @returns 统计结果
 */
export function computeRhythmStats(shots: Shot[]): RhythmStats {
  const shotCount = shots.length;
  if (shotCount === 0) {
    return { shotCount: 0, avgShotDuration: 0, cutCount: 0 };
  }
  const sumDuration = shots.reduce((sum, s) => sum + s.duration, 0);
  return {
    shotCount,
    avgShotDuration: sumDuration / shotCount,
    cutCount: Math.max(0, shotCount - 1),
  };
}
