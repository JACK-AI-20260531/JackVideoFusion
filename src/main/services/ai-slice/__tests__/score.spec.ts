/**
 * AI 切片评分纯函数单测
 * 职责:验证 clamp 数值限定、scoreDuration 时长评分(黄金区间/过短/过长)、
 *      computeTotalScore 综合得分公式与权重、gradeOf 等级映射、
 *      mapHeuristicToVirality 启发式降级映射
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-slice/__tests__/score.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  scoreDuration,
  computeTotalScore,
  gradeOf,
  mapHeuristicToVirality,
} from '../score.ts';

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

describe('gradeOf', () => {
  it('S>=85 / A>=70 / B>=55 / C<55 边界正确', () => {
    assert.equal(gradeOf(100), 'S');
    assert.equal(gradeOf(85), 'S');
    assert.equal(gradeOf(84), 'A');
    assert.equal(gradeOf(70), 'A');
    assert.equal(gradeOf(69), 'B');
    assert.equal(gradeOf(55), 'B');
    assert.equal(gradeOf(54), 'C');
    assert.equal(gradeOf(0), 'C');
  });
});

describe('mapHeuristicToVirality', () => {
  it('0-1 评分映射为 0-100 分,S/A/B/C 等级随分变化', () => {
    const low = mapHeuristicToVirality(0);
    assert.equal(low.score, 0);
    assert.equal(low.grade, 'C');

    const mid = mapHeuristicToVirality(0.8);
    assert.equal(mid.score, 80);
    assert.equal(mid.grade, 'A');

    const top = mapHeuristicToVirality(1);
    assert.equal(top.score, 100);
    assert.equal(top.grade, 'S');
  });

  it('五维子分统一取综合分,来源为 heuristic,不生成标题/标签', () => {
    const report = mapHeuristicToVirality(0.6);
    assert.equal(report.sub.hook, 60);
    assert.equal(report.sub.titleability, 60);
    assert.equal(report.source, 'heuristic');
    assert.equal(report.reasons.length, 1);
    assert.equal(report.suggestions.length, 0);
    assert.equal(report.titles.length, 0);
    assert.equal(report.tags.length, 0);
    assert.equal(report.coverText.length, 0);
  });

  it('超出 0-1 的输入被钳制', () => {
    assert.equal(mapHeuristicToVirality(-1).score, 0);
    assert.equal(mapHeuristicToVirality(2).score, 100);
  });
});
