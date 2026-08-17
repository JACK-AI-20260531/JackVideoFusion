/**
 * 随机选段纯函数工具
 * 职责:提供可复现的 LCG 随机数与 Fisher-Yates 洗牌
 *      纯函数,不依赖 electron/fs/logger,可独立单元测试
 */

/**
 * 生成线性同余随机数生成器(LCG)
 * 同一 seed 产生同一序列,便于单测复现;未传 seed 则使用 Math.random
 * @param seed 随机种子
 */
export function createRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let state = seed >>> 0;
  return () => {
    // LCG 参数取 glibc 常数,保证可复现
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Fisher-Yates 洗牌(原地修改数组并返回引用)
 * @param arr 待洗牌数组
 * @param rng 随机数生成器
 */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

