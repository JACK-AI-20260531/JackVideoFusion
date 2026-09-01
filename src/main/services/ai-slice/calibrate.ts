/**
 * 爆款评分权重自学习(PRD-v1.7 数据飞轮与全景矩阵 FR-3)
 *
 * 职责:
 *   - 五维权重的常量定义与归一化(normalizeWeights)
 *   - 皮尔逊相关系数(pearsonCorrelation)
 *   - 由"五维子分 × 实际互动率"样本校准权重(calibrateWeights)
 *   - 评分历史与发布数据的样本拼接(joinCalibrationSamples)
 *
 * 设计要点:
 *   - 全部纯函数,不依赖 electron,可 node:test 单测
 *   - 校准规则:各维度与互动率的皮尔逊相关系数(负相关截断为 0)→ 归一化 →
 *     与基准权重按 `0.3 新 + 0.7 旧` 平滑混合,防单次过拟合
 *   - 样本不足(默认 <20)或全部维度零/负相关时回退默认权重(learned=false)
 */
import type { ViralitySubScores } from './types';

/** 五维子分键名 */
export const VIRALITY_SUB_KEYS = ['hook', 'emotion', 'topic', 'retention', 'titleability'] as const;

/** 单个五维子分键名 */
export type ViralitySubScoreKey = (typeof VIRALITY_SUB_KEYS)[number];

/** 五维权重(各键 0-1,和为 1) */
export type ViralityWeights = Record<ViralitySubScoreKey, number>;

/** 默认五维权重(与 VIRALITY_SYSTEM 提示词中的权重一致) */
export const DEFAULT_VIRALITY_WEIGHTS: ViralityWeights = {
  hook: 0.25,
  emotion: 0.2,
  topic: 0.25,
  retention: 0.2,
  titleability: 0.1,
};

/** 启用校准的最小样本数(不足则回退默认权重) */
export const CALIBRATION_MIN_SAMPLES = 20;

/** 平滑混合的新权重占比(新 = 0.3 / 旧 = 0.7) */
export const CALIBRATION_NEW_WEIGHT = 0.3;

/**
 * 归一化权重输入:非法键丢弃、合法键归一化到和为 1
 * 全部非法或合法键之和为 0 时回退默认权重
 * @param input 任意形状的权重输入(如持久化反序列化结果)
 * @returns 和为 1 的五维权重
 */
export function normalizeWeights(input: unknown): ViralityWeights {
  if (!input || typeof input !== 'object') return { ...DEFAULT_VIRALITY_WEIGHTS };
  const record = input as Record<string, unknown>;
  const valid = VIRALITY_SUB_KEYS.map((key) => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const sum = valid.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) return { ...DEFAULT_VIRALITY_WEIGHTS };
  return Object.fromEntries(
    VIRALITY_SUB_KEYS.map((key, i) => [key, valid[i] / sum]),
  ) as unknown as ViralityWeights;
}

/**
 * 皮尔逊相关系数
 *   r = Σ(x-x̄)(y-ȳ) / sqrt(Σ(x-x̄)² · Σ(y-ȳ)²)
 * @param xs 变量 X 序列
 * @param ys 变量 Y 序列(与 X 等长)
 * @returns 相关系数 [-1, 1];方差为 0 或长度不足 2 时返回 null
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** 校准样本:单条视频的五维子分与实际互动率 */
export interface CalibrationSample {
  /** 五维子分(0-100) */
  sub: ViralitySubScores;
  /** 实际互动率 = (点赞 + 评论) / 播放,>= 0 */
  engagement: number;
}

/** 校准结果 */
export interface CalibrationResult {
  /** 校准后的权重(learned=false 时为默认/基准权重) */
  weights: ViralityWeights;
  /** 是否真正执行了学习(样本充足且存在有效正相关) */
  learned: boolean;
  /** 参与校准的样本数 */
  sampleCount: number;
}

/** calibrateWeights 选项 */
export interface CalibrateOptions {
  /** 最小样本数(默认 20,不足回退) */
  minSamples?: number;
  /** 新结果占比(默认 0.3,旧基准占 0.7) */
  newWeight?: number;
  /** 基准权重(默认 DEFAULT_VIRALITY_WEIGHTS) */
  baseWeights?: ViralityWeights;
}

/**
 * 由样本校准五维权重
 * 流程:样本不足 → 回退;各维度与互动率求皮尔逊相关 → 负相关截 0 →
 *      全零回退 → 归一化 → 与基准权重平滑混合(混合后天然归一)
 * @param samples 校准样本
 * @param options 可选参数(minSamples/newWeight/baseWeights)
 * @returns 校准结果(权重 + 是否学习 + 样本数)
 */
export function calibrateWeights(
  samples: CalibrationSample[],
  options: CalibrateOptions = {},
): CalibrationResult {
  const minSamples = options.minSamples ?? CALIBRATION_MIN_SAMPLES;
  const newWeight = options.newWeight ?? CALIBRATION_NEW_WEIGHT;
  const base = options.baseWeights ?? DEFAULT_VIRALITY_WEIGHTS;

  if (samples.length < minSamples) {
    return { learned: false, sampleCount: samples.length, weights: { ...base } };
  }

  const engagement = samples.map((s) => s.engagement);
  const raw: Partial<Record<ViralitySubScoreKey, number>> = {};
  let positive = 0;
  for (const key of VIRALITY_SUB_KEYS) {
    const dim = samples.map((s) => s.sub[key] as number);
    const r = pearsonCorrelation(dim, engagement);
    const clamped = r !== null && r > 0 ? r : 0;
    raw[key] = clamped;
    if (clamped > 0) positive++;
  }
  if (positive === 0) {
    // 全部维度零/负相关:数据无区分度,回退基准权重
    return { learned: false, sampleCount: samples.length, weights: { ...base } };
  }

  // 归一化(正数之和 > 0,必然可归一)
  const rawSum = VIRALITY_SUB_KEYS.reduce((acc, k) => acc + (raw[k] as number), 0);
  const normalized = Object.fromEntries(
    VIRALITY_SUB_KEYS.map((k) => [k, (raw[k] as number) / rawSum]),
  ) as unknown as ViralityWeights;

  // 平滑混合:blended = newWeight * normalized + (1-newWeight) * base(两侧均归一,和恒为 1)
  const blended = Object.fromEntries(
    VIRALITY_SUB_KEYS.map((k) => [k, newWeight * normalized[k] + (1 - newWeight) * base[k]]),
  ) as unknown as ViralityWeights;

  return { learned: true, sampleCount: samples.length, weights: blended };
}

/** 评分历史条目样本(结构化最小接口,便于拼接与测试) */
export interface ScoreHistoryClipLike {
  /** 切片输出文件绝对路径(与发布任务 videoPath 精确匹配) */
  outputPath: string;
  /** 五维子分 */
  sub: ViralitySubScores;
}

/** 发布分析记录样本(结构化最小接口) */
export interface CalibrationAnalyticsLike {
  /** 关联的发布视频文件路径 */
  videoPath?: string;
  /** 历次采集时间线(最新在末尾) */
  history: { plays?: number; likes?: number; comments?: number }[];
}

/**
 * 拼接校准样本:评分历史(切片路径 → 五维子分)× 发布分析(视频路径 → 最新互动数据)
 * 匹配规则:切片 outputPath === 分析记录 videoPath(精确匹配),取最新一次采集;
 *          播放数缺失或 ≤0 的记录跳过(互动率无意义)
 * @param historyEntries 评分历史条目
 * @param records 发布分析记录
 * @returns 校准样本(供 calibrateWeights 消费)
 */
export function joinCalibrationSamples(
  history: ScoreHistoryClipLike[][],
  records: CalibrationAnalyticsLike[],
): CalibrationSample[] {
  // 切片路径 → 五维子分(后写覆盖先写,以最近一次评分为准)
  const subByPath = new Map<string, ViralitySubScores>();
  for (const entry of history) {
    for (const clip of entry) {
      if (clip?.outputPath && clip.sub) subByPath.set(clip.outputPath, clip.sub);
    }
  }

  const samples: CalibrationSample[] = [];
  for (const record of records) {
    if (!record?.videoPath) continue;
    const sub = subByPath.get(record.videoPath);
    if (!sub) continue;
    const latest = record.history[record.history.length - 1];
    if (!latest || typeof latest.plays !== 'number' || latest.plays <= 0) continue;
    const likes = typeof latest.likes === 'number' ? latest.likes : 0;
    const comments = typeof latest.comments === 'number' ? latest.comments : 0;
    samples.push({ sub, engagement: (likes + comments) / latest.plays });
  }
  return samples;
}
