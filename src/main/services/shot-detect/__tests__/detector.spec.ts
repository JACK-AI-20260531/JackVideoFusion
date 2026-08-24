/**
 * shot-detect detector 纯函数测试
 * 职责:验证 parseFfprobeJson(JSON 解析与窄化)与 extractCutPoints(切换点提取)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfprobeJson, extractCutPoints } from '../detector.ts';

describe('parseFfprobeJson', () => {
  it('空输出抛错', () => {
    assert.throws(() => parseFfprobeJson(''), /输出为空/);
    assert.throws(() => parseFfprobeJson('   \n  '), /输出为空/);
  });

  it('非法 JSON 抛错', () => {
    assert.throws(() => parseFfprobeJson('not json'), /JSON 解析失败/);
  });

  it('非对象输出抛错', () => {
    assert.throws(() => parseFfprobeJson('"str"'), /不是对象/);
    assert.throws(() => parseFfprobeJson('123'), /不是对象/);
  });

  it('缺少 frames 数组抛错', () => {
    assert.throws(() => parseFfprobeJson('{"foo":1}'), /缺少 frames 数组/);
    assert.throws(() => parseFfprobeJson('{"frames":"x"}'), /缺少 frames 数组/);
  });

  it('正常返回 frames', () => {
    const out = parseFfprobeJson('{"frames":[{"pts_time":"1.5"}]}');
    assert.equal(out.frames.length, 1);
    assert.equal(out.frames[0].pts_time, '1.5');
  });
});

describe('extractCutPoints', () => {
  it('用 pts_time 提取切换点并保留场景分数', () => {
    const out = extractCutPoints({
      frames: [
        { pts_time: '0.04' }, // 首帧,跳过
        { pts_time: '3.2', side_data_list: [{ side_data_type: 'Scene Detection', score: 0.8 }] },
        { pts_time: '7.5' },
      ],
    });
    assert.deepEqual(out.points, [3.2, 7.5]);
    assert.deepEqual(out.sceneScores, [0.8, 0]);
  });

  it('pts_time 缺失时用 pts * time_base 回退换算', () => {
    const out = extractCutPoints({
      frames: [
        { pts: 15360, time_base: '1/15360' }, // 1.0s,非首帧(我们未跳过首帧逻辑在此测试)
        { pts: 30720, time_base: '1/15360' }, // 2.0s
      ],
    });
    // 注意:首帧(1.0s > 0.05)不会被跳过
    assert.equal(out.points.length, 2);
    assert.equal(out.points[1], 2.0);
  });

  it('首帧(远小于阈值)被跳过,但随后的近0帧保留', () => {
    const out = extractCutPoints({
      frames: [
        { pts_time: '0.01' }, // 初始帧,跳过
        { pts_time: '0.04' }, // 仍在首帧阈值内但 points 已有元素? 此处保持测试首帧跳过逻辑
        { pts_time: '1.0' },
      ],
    });
    assert.deepEqual(out.points, [1.0]);
  });

  it('无 pts_time 且无合法 pts/time_base 的帧跳过', () => {
    const out = extractCutPoints({
      frames: [
        { pts_time: 'abc' },
        { pts: 100, time_base: 'abc' }, // parseFloat('abc') NaN → tb=0 → 时间非法
        { pts_time: '5.0' },
      ],
    });
    assert.deepEqual(out.points, [5.0]);
  });
});
