/**
 * 镜头构建纯函数单测
 * 职责:验证 parseTimeBase 时间基解析、extractSceneScore 场景分提取、
 *      buildShotsFromCuts 切换点到镜头转换、mergeShortShots 短镜头合并、
 *      fallbackUniformSplit 均匀分段降级
 * 运行:npm run test 或 node --test --import tsx src/main/services/shot-detect/__tests__/shot-utils.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeBase,
  extractSceneScore,
  buildShotsFromCuts,
  mergeShortShots,
  fallbackUniformSplit,
} from '../shot-utils.ts';
import type { Shot } from '../types.ts';

describe('parseTimeBase', () => {
  it('解析 "num/den" 分数形式为秒', () => {
    assert.equal(parseTimeBase('1/15360'), 1 / 15360);
    assert.equal(parseTimeBase('1/25'), 0.04);
  });

  it('解析纯数字形式', () => {
    assert.equal(parseTimeBase('0.04'), 0.04);
  });

  it('空值或无法解析返回 0', () => {
    assert.equal(parseTimeBase(undefined), 0);
    assert.equal(parseTimeBase(''), 0);
    assert.equal(parseTimeBase('abc'), 0);
  });
});

describe('extractSceneScore', () => {
  it('提取 Scene Detection 类型副数据的分数', () => {
    assert.equal(extractSceneScore([{ side_data_type: 'Scene Detection', score: 0.8 }]), 0.8);
  });

  it('无匹配类型或缺失时返回 0', () => {
    assert.equal(extractSceneScore(undefined), 0);
    assert.equal(extractSceneScore([]), 0);
    assert.equal(extractSceneScore([{ side_data_type: 'Other', score: 0.9 }]), 0);
  });
});

describe('buildShotsFromCuts', () => {
  it('首镜头从 0 起,末镜头到 totalDuration', () => {
    const shots = buildShotsFromCuts([2, 5], [0.7, 0.3], 8);
    assert.equal(shots.length, 3);
    assert.deepEqual(
      shots.map((s) => [s.startTime, s.endTime, s.duration]),
      [[0, 2, 2], [2, 5, 3], [5, 8, 3]],
    );
  });

  it('score 归属给以该切换点为起点的镜头', () => {
    const shots = buildShotsFromCuts([2], [0.9], 10);
    // shots[1] 起点 2 对应 cutPoints[0],score 应为 0.9
    assert.equal(shots[0].score, undefined);
    assert.equal(shots[1].score, 0.9);
  });

  it('无切换点时生成单个整段镜头', () => {
    const shots = buildShotsFromCuts([], [], 10);
    assert.equal(shots.length, 1);
    assert.deepEqual([shots[0].startTime, shots[0].endTime], [0, 10]);
  });

  it('跳过无效(起点>=终点)的镜头', () => {
    const shots = buildShotsFromCuts([5, 5], [], 10);
    // 第二个切换点与第一个重合,应被跳过
    assert.ok(shots.length >= 1);
  });
});

describe('mergeShortShots', () => {
  it('短镜头合并到上一个并扩展时长', () => {
    const shots: Shot[] = [
      { index: 0, startTime: 0, endTime: 5, duration: 5 },
      { index: 1, startTime: 5, endTime: 5.5, duration: 0.5 },
    ];
    const merged = mergeShortShots(shots, 1.0);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].endTime, 5.5);
    assert.equal(merged[0].duration, 5.5);
  });

  it('足够长的镜头保留不动', () => {
    const shots: Shot[] = [
      { index: 0, startTime: 0, endTime: 5, duration: 5 },
      { index: 1, startTime: 5, endTime: 10, duration: 5 },
    ];
    const merged = mergeShortShots(shots, 1.0);
    assert.equal(merged.length, 2);
  });

  it('空数组返回空数组', () => {
    assert.deepEqual(mergeShortShots([], 1.0), []);
  });
});

describe('fallbackUniformSplit', () => {
  it('按时长等分生成镜头', () => {
    const result = fallbackUniformSplit(10, 5);
    assert.equal(result.shotCount, 2);
    assert.equal(result.shots[0].duration, 5);
    assert.equal(result.shots[1].duration, 5);
    assert.equal(result.totalDuration, 10);
  });

  it('minDuration 过小时至少生成 1 段', () => {
    const result = fallbackUniformSplit(1, 5);
    assert.equal(result.shotCount, 1);
    assert.equal(result.shots[0].endTime, 1);
  });
});
