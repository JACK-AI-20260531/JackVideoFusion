/**
 * AI 切片评分纯函数
 * 职责:镜头时长评分、数值限定、综合得分计算
 *      纯函数,不依赖 electron/CLIP/taskQueue,可独立单元测试
 */

/** 黄金时长区间下限(秒) */
export const GOLDEN_MIN_SEC = 8;
/** 黄金时长区间上限(秒) */
export const GOLDEN_MAX_SEC = 30;

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
 * 计算镜头时长评分
 * 8-30 秒为黄金区间(评分 1),<8 秒线性递减,>30 秒线性递减
 * @param duration 镜头时长(秒)
 * @returns 时长评分(0-1)
 */
export function scoreDuration(duration: number): number {
  if (duration >= GOLDEN_MIN_SEC && duration <= GOLDEN_MAX_SEC) {
    return 1;
  }
  if (duration < GOLDEN_MIN_SEC) {
    return clamp(duration / GOLDEN_MIN_SEC, 0, 1);
  }
  // 超过 30 秒:每超 60 秒降 1,最低 0
  const overflow = duration - GOLDEN_MAX_SEC;
  return clamp(1 - overflow / 60, 0, 1);
}

/**
 * 计算镜头综合精彩度得分
 * 综合 = 0.4 * 场景分 + 0.3 * 时长分 + 0.3 * CLIP 分,归一化到 0-1
 * @param sceneScore 场景变化分数(0-1)
 * @param durationScore 时长评分(0-1)
 * @param clipScore CLIP 语义评分(0-1)
 * @returns 综合得分(0-1)
 */
export function computeTotalScore(
  sceneScore: number,
  durationScore: number,
  clipScore: number,
): number {
  return clamp(
    0.4 * clamp(sceneScore, 0, 1) +
      0.3 * clamp(durationScore, 0, 1) +
      0.3 * clamp(clipScore, 0, 1),
    0,
    1,
  );
}
