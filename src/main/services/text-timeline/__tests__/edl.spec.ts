/**
 * EDL 变换纯函数单测(PRD-文本即时间线 v2.0 M1)
 * 覆盖 PRD 6.4 边界:相邻/嵌套/越界
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEdl,
  applyCut,
  applyMute,
  applyMove,
  applyOps,
  totalDuration,
  isValidRange,
} from '../edl';

describe('createEdl', () => {
  it('初始 EDL 为单个全长片段', () => {
    const edl = createEdl('a.mp4', 60);
    assert.equal(edl.clips.length, 1);
    assert.equal(edl.clips[0].srcStart, 0);
    assert.equal(edl.clips[0].srcEnd, 60);
    assert.equal(totalDuration(edl), 60);
  });
});

describe('applyCut', () => {
  it('中间删除:片段一分为二', () => {
    const edl = createEdl('a.mp4', 100);
    const out = applyCut(edl, 40, 50);
    assert.equal(out.clips.length, 2);
    assert.equal(out.clips[0].srcEnd, 40);
    assert.equal(out.clips[1].srcStart, 50);
    assert.equal(totalDuration(out), 90);
    // 原 EDL 不被修改(非破坏性)
    assert.equal(totalDuration(edl), 100);
  });

  it('嵌套删除(片段内再删)自然生效', () => {
    let edl = applyCut(createEdl('a.mp4', 100), 30, 70);
    edl = applyCut(edl, 40, 60); // 已删区间内再删
    assert.equal(edl.clips.length, 2);
    assert.equal(totalDuration(edl), 60);
  });

  it('相邻删除:两次删除相接区间后融合为一次边界', () => {
    let edl = applyCut(createEdl('a.mp4', 100), 40, 50);
    edl = applyCut(edl, 50, 60); // 与上次删除区相邻
    assert.equal(edl.clips.length, 2);
    assert.equal(edl.clips[0].srcEnd, 40);
    assert.equal(edl.clips[1].srcStart, 60);
  });

  it('越界区间被裁剪到合法范围', () => {
    const edl = applyCut(createEdl('a.mp4', 100), 90, 200);
    assert.equal(totalDuration(edl), 90);
    assert.equal(edl.clips.length, 1);
    assert.equal(edl.clips[0].srcEnd, 90);
  });

  it('非法区间(倒置/全越界)不生效,半越界自动钳制', () => {
    const edl = createEdl('a.mp4', 100);
    assert.equal(totalDuration(applyCut(edl, 50, 40)), 100); // 倒置 → 不动
    assert.equal(totalDuration(applyCut(edl, -10, 20)), 80); // 负起点钳制到 0 → 剪 [0,20)
    assert.equal(totalDuration(applyCut(edl, 150, 160)), 100); // 全越界 → 不动
  });
});

describe('applyMute', () => {
  it('整体静音:片段打标不拆分', () => {
    const edl = applyMute(createEdl('a.mp4', 100), 0, 100);
    assert.equal(edl.clips.length, 1);
    assert.equal(edl.clips[0].muted, true);
    assert.equal(totalDuration(edl), 100);
  });

  it('部分静音:片段在边界处拆分', () => {
    const out = applyMute(createEdl('a.mp4', 100), 20, 30);
    assert.equal(out.clips.length, 3);
    assert.equal(out.clips[0].muted ?? false, false);
    assert.equal(out.clips[1].muted, true);
    assert.equal(out.clips[2].muted ?? false, false);
    assert.equal(totalDuration(out), 100);
  });

  it('cut 优先:已删区间上的 mute 不复活素材', () => {
    let edl = applyCut(createEdl('a.mp4', 100), 40, 50);
    edl = applyMute(edl, 0, 100);
    assert.equal(edl.clips.length, 2);
    assert.equal(totalDuration(edl), 90);
  });
});

describe('applyMove', () => {
  it('移动区间内的片段到目标位置', () => {
    let edl = applyCut(createEdl('a.mp4', 100), 50, 60); // clips: [0,50), [60,100)
    edl = applyMove(edl, 60, 100, 0); // 把 [60,100) 移到最前
    assert.equal(edl.clips.length, 2);
    assert.equal(edl.clips[0].srcStart, 60);
    assert.equal(edl.clips[1].srcStart, 0);
  });

  it('区间内无片段 → 不变', () => {
    const edl = createEdl('a.mp4', 100);
    const out = applyMove(edl, 200, 300, 0);
    assert.equal(out.clips.length, 1);
  });

  it('dstIndex 越界自动钳制', () => {
    let edl = applyCut(createEdl('a.mp4', 100), 50, 60); // clips: [0,50), [60,100)
    edl = applyMove(edl, 60, 100, 99); // dstIndex 99 钳制到 rest.length=1
    assert.equal(edl.clips.length, 2);
    assert.equal(edl.clips[1].srcStart, 60);
  });
});

describe('applyOps', () => {
  it('按顺序应用多条操作', () => {
    const edl = createEdl('a.mp4', 100);
    const out = applyOps(edl, [
      { op: 'cut', start: 20, end: 30, reason: '删句' },
      { op: 'mute', start: 0, end: 10, reason: '静音开头' },
    ]);
    assert.equal(totalDuration(out), 90);
    assert.equal(out.clips.length, 3);
    assert.equal(out.clips[0].muted, true);
  });

  it('非法 op 跳过不阻断', () => {
    const out = applyOps(createEdl('a.mp4', 100), [
      { op: 'cut', start: 80, end: 30, reason: '倒置' },
      { op: 'cut', start: 10, end: 20, reason: '合法' },
    ]);
    assert.equal(totalDuration(out), 90);
  });
});
