/**
 * 权重自学习纯函数单测(PRD-v1.7 FR-3)
 * 覆盖:皮尔逊相关 / 权重归一化 / 校准回退 / 平滑混合 / 样本拼接
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIRALITY_WEIGHTS,
  VIRALITY_SUB_KEYS,
  normalizeWeights,
  pearsonCorrelation,
  calibrateWeights,
  joinCalibrationSamples,
} from '../calibrate';
import type { CalibrationSample } from '../calibrate';
import type { ViralitySubScores } from '../types';

/** 构造五维子分 */
function sub(hook: number, overrides: Partial<ViralitySubScores> = {}): ViralitySubScores {
  return {
    hook,
    emotion: 50,
    topic: 50,
    retention: 50,
    titleability: 50,
    ...overrides,
  };
}

describe('pearsonCorrelation', () => {
  it('完全正相关 → 1', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40]);
    assert.ok(r !== null);
    assert.ok(Math.abs(r - 1) < 1e-9);
  });

  it('完全负相关 → -1', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [40, 30, 20, 10]);
    assert.ok(r !== null);
    assert.ok(Math.abs(r + 1) < 1e-12);
  });

  it('零方差 → null', () => {
    assert.equal(pearsonCorrelation([5, 5, 5], [1, 2, 3]), null);
    assert.equal(pearsonCorrelation([1, 2, 3], [5, 5, 5]), null);
  });

  it('样本数不足 2 → null', () => {
    assert.equal(pearsonCorrelation([1], [2]), null);
    assert.equal(pearsonCorrelation([], []), null);
  });
});

describe('normalizeWeights', () => {
  it('非法输入回退默认权重', () => {
    assert.deepEqual(normalizeWeights(null), DEFAULT_VIRALITY_WEIGHTS);
    assert.deepEqual(normalizeWeights('x'), DEFAULT_VIRALITY_WEIGHTS);
    assert.deepEqual(normalizeWeights({ hook: 'bad' }), DEFAULT_VIRALITY_WEIGHTS);
  });

  it('全非正数回退默认权重', () => {
    assert.deepEqual(
      normalizeWeights({ hook: 0, emotion: -1, topic: NaN }),
      DEFAULT_VIRALITY_WEIGHTS,
    );
  });

  it('部分合法键归一化到和为 1', () => {
    const w = normalizeWeights({ hook: 2, emotion: 1 });
    const sum = VIRALITY_SUB_KEYS.reduce((acc, k) => acc + w[k], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(Math.abs(w.hook - 2 / 3) < 1e-9);
    assert.ok(Math.abs(w.emotion - 1 / 3) < 1e-9);
  });

  it('完整合法输入保持比例', () => {
    const w = normalizeWeights(DEFAULT_VIRALITY_WEIGHTS);
    for (const key of VIRALITY_SUB_KEYS) {
      assert.ok(Math.abs(w[key] - DEFAULT_VIRALITY_WEIGHTS[key]) < 1e-9);
    }
  });
});

describe('calibrateWeights', () => {
  it('样本不足回退基准权重', () => {
    const samples: CalibrationSample[] = Array.from({ length: 19 }, (_, i) => ({
      sub: sub(i + 1),
      engagement: i / 10,
    }));
    const result = calibrateWeights(samples);
    assert.equal(result.learned, false);
    assert.equal(result.sampleCount, 19);
    assert.deepEqual(result.weights, DEFAULT_VIRALITY_WEIGHTS);
  });

  it('强正相关维度获得最大权重(学习生效)', () => {
    // hook 与互动率完全正相关,其余维度恒定(零方差 → 相关为 0)
    const samples: CalibrationSample[] = Array.from({ length: 25 }, (_, i) => ({
      sub: sub(i + 1),
      engagement: (i + 1) / 100,
    }));
    const result = calibrateWeights(samples);
    assert.equal(result.learned, true);
    assert.equal(result.sampleCount, 25);
    // 平滑混合后 hook 权重 = 0.3*1 + 0.7*0.25 = 0.475(最大),其余 = 0.7*base
    assert.ok(Math.abs(result.weights.hook - (0.3 * 1 + 0.7 * 0.25)) < 1e-9);
    assert.ok(Math.abs(result.weights.emotion - 0.7 * 0.2) < 1e-9);
    const sum = VIRALITY_SUB_KEYS.reduce((acc, k) => acc + result.weights[k], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it('全部维度零/负相关回退基准权重', () => {
    const samples: CalibrationSample[] = Array.from({ length: 30 }, () => ({
      sub: sub(50),
      engagement: 0.1,
    }));
    const result = calibrateWeights(samples);
    assert.equal(result.learned, false);
    assert.deepEqual(result.weights, DEFAULT_VIRALITY_WEIGHTS);
  });

  it('负相关被截断为 0 不产生负权重', () => {
    // hook 与互动率负相关,topic 正相关
    const samples: CalibrationSample[] = Array.from({ length: 25 }, (_, i) => ({
      sub: sub(10, { topic: (i + 1) * 4 }),
      engagement: (i + 1) / 100,
    }));
    const result = calibrateWeights(samples);
    assert.equal(result.learned, true);
    assert.ok(result.weights.hook >= 0);
    assert.ok(result.weights.topic > result.weights.hook);
  });

  it('自定义 minSamples/newWeight 生效', () => {
    const samples: CalibrationSample[] = Array.from({ length: 5 }, (_, i) => ({
      sub: sub(i + 1),
      engagement: (i + 1) / 10,
    }));
    const result = calibrateWeights(samples, { minSamples: 5 });
    assert.equal(result.learned, true);
    assert.ok(result.weights.hook > DEFAULT_VIRALITY_WEIGHTS.hook);
  });
});

describe('joinCalibrationSamples', () => {
  it('按切片路径精确匹配并取最新采集', () => {
    const history = [
      [
        { outputPath: 'C:/a.mp4', sub: sub(80) },
        { outputPath: 'C:/b.mp4', sub: sub(60) },
      ],
      [{ outputPath: 'C:/a.mp4', sub: sub(90) }],
    ];
    const records = [
      {
        videoPath: 'C:/a.mp4',
        history: [
          { plays: 100, likes: 5, comments: 5, collectedAt: '2026-01-01T00:00:00Z' },
          { plays: 200, likes: 10, comments: 10, collectedAt: '2026-01-02T00:00:00Z' },
        ],
      },
      { videoPath: 'C:/missing.mp4', history: [{ plays: 100, collectedAt: 'x' }] },
      {
        videoPath: 'C:/b.mp4',
        history: [{ plays: 0, likes: 9, comments: 9, collectedAt: 'x' }],
      },
    ];
    const samples = joinCalibrationSamples(history, records as never);
    // 仅 C:/a.mp4 匹配(有评分 + 有有效播放);C:/b.mp4 无分析记录;缺播放的跳过
    assert.equal(samples.length, 1);
    assert.equal(samples[0].sub.hook, 90);
    assert.ok(Math.abs(samples[0].engagement - 20 / 200) < 1e-9);
  });

  it('空历史/无 videoPath 安全跳过', () => {
    const samples = joinCalibrationSamples([], [
      { videoPath: undefined, history: [] },
      { videoPath: 'C:/x.mp4', history: [] },
    ] as never);
    assert.equal(samples.length, 0);
  });
});
