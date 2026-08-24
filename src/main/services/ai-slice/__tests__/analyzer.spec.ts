/**
 * AI 切片分析纯逻辑单测
 * 职责:验证 filterAndRankShots 的达标过滤(时长区间 + 阈值)与评分排序
 * 说明:纯函数;analyzeShots 主流程依赖 CLIP 服务,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-slice/__tests__/analyzer.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndRankShots, midTimeOf } from '../analyzer.ts';
import type { Shot } from '../../shot-detect/types';
import type { AnalyzedShot, AnalyzeOptions } from '../types';

function shot(index: number, duration: number): Shot {
  return { index, startTime: index * 10, endTime: index * 10 + duration, duration };
}

function analyzed(shot: Shot, score: number): AnalyzedShot {
  return { shot, score };
}

describe('midTimeOf', () => {
  it('计算起点与终点的中点', () => {
    assert.equal(midTimeOf({ index: 0, startTime: 0, endTime: 10, duration: 10 }), 5);
    assert.equal(midTimeOf({ index: 0, startTime: 5, endTime: 15, duration: 10 }), 10);
  });

  it('零时长镜头返回该时间点', () => {
    assert.equal(midTimeOf({ index: 0, startTime: 4, endTime: 4, duration: 0 }), 4);
  });
});

const opts: AnalyzeOptions = {
  minClipDuration: 8,
  maxClipDuration: 30,
  excitementThreshold: 0.5,
};

describe('filterAndRankShots', () => {
  it('只保留时长在区间内且评分超阈值(boundary:包含边界值,排除相等阈值)的镜头', () => {
    // dur=8 达到 min(含);dur=30 达到 max(含);score=0.5 等于阈值(> 需排除)
    const input: AnalyzedShot[] = [
      analyzed(shot(0, 8), 0.9), // 时长=min,评分高 → 保留
      analyzed(shot(1, 30), 0.8), // 时长=max,评分高 → 保留
      analyzed(shot(2, 7), 0.9), // 时长 < min → 剔除
      analyzed(shot(3, 31), 0.9), // 时长 > max → 剔除
      analyzed(shot(4, 10), 0.5), // 评分=阈值(不 >) → 剔除
      analyzed(shot(5, 10), 0.51), // 评分略超阈值 → 保留
    ];
    const result = filterAndRankShots(input, opts);
    assert.deepEqual(
      result.map((a) => a.shot.index),
      [0, 1, 5],
    );
  });

  it('按评分降序返回', () => {
    const input: AnalyzedShot[] = [
      analyzed(shot(0, 10), 0.6),
      analyzed(shot(1, 10), 0.9),
      analyzed(shot(2, 10), 0.7),
    ];
    const result = filterAndRankShots(input, opts);
    assert.deepEqual(
      result.map((a) => a.score),
      [0.9, 0.7, 0.6],
    );
  });

  it('无达标镜头时返回空数组', () => {
    const input: AnalyzedShot[] = [
      analyzed(shot(0, 4), 0.9), // 时长短
      analyzed(shot(1, 20), 0.2), // 评分低
    ];
    assert.deepEqual(filterAndRankShots(input, opts), []);
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(filterAndRankShots([], opts), []);
  });
});
