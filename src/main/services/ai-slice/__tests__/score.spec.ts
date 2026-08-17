/**
 * AI 切片评分纯函数单测
 * 职责:验证 clamp 数值限定、scoreDuration 时长评分(黄金区间/过短/过长)、
 *      computeTotalScore 综合得分公式与权重
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-slice/__tests__/score.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, scoreDuration, computeTotalScore } from '../score.ts';

describe('clamp', () => {
  it('值在区间内保持不变', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it('值低于下限时取下限,高于上限时取上限', () => {
    assert.equal(clamp(-3, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
  });
});

describe('scoreDuration', () => {
  it('8-30 秒黄金区间评分 1', () => {
    assert.equal(scoreDuration(8), 1);
    assert.equal(scoreDuration(20), 1);
    assert.equal(scoreDuration(30), 1);
  });

  it('过短(<8 秒)按占比线性降分', () => {
    assert.equal(scoreDuration(8), 1);
    assert.equal(scoreDuration(4), 0.5);
    assert.equal(scoreDuration(0), 0);
  });

  it('过长(>30 秒)每超 60 秒降 1,最低 0', () => {
    // 42 秒:超过 30 秒 12 秒,1-12/60=0.8
    assert.equal(scoreDuration(42), 0.8);
    // 60 秒:30 秒外再多 30,1-30/60=0.5
    assert.equal(scoreDuration(60), 0.5);
    // 90 秒:1-60/60=0
    assert.equal(scoreDuration(90), 0);
  });
});

describe('computeTotalScore', () => {
  it('按 0.4/0.3/0.3 权重合成', () => {
    const total = computeTotalScore(1, 1, 1);
    assert.equal(total, 1);
  });

  it('各分量被限制在 0-1,合成值归一化到 0-1', () => {
    const total = computeTotalScore(2, 0.5, 0.5);
    // 0.4*1 + 0.3*0.5 + 0.3*0.5 = 0.7(浮点近似)
    assert.ok(Math.abs(total - 0.7) < 1e-9);
    assert.ok(total >= 0 && total <= 1);
  });
});
