/**
 * SRT 转写解析与编辑计划纯函数单测(PRD-文本即时间线 v2.0 M1)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrtToSegments,
  planFillerCuts,
  planPauseCompression,
  CUT_MARGIN_SEC,
} from '../transcript';

describe('parseSrtToSegments', () => {
  it('解析多块 SRT 为句级段落(时间戳转秒)', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,500',
      '大家好,今天聊聊剪辑。',
      '',
      '2',
      '00:00:03,500 --> 00:00:06,200',
      '接下来看第二个案例。',
    ].join('\n');
    const segs = parseSrtToSegments(srt);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].id, 'seg-1');
    assert.equal(segs[0].start, 1);
    assert.equal(segs[0].end, 3.5);
    assert.equal(segs[1].start, 3.5);
    assert.equal(segs[1].end, 6.2);
  });

  it('时间戳非法的块跳过', () => {
    const srt = ['1', 'bad --> worse', '坏块'].join('\n\n');
    assert.deepEqual(parseSrtToSegments(srt), []);
  });
});

describe('planFillerCuts', () => {
  it('词级时间戳存在:只剪口头禅词区间(外扩 0.15s)', () => {
    const seg = {
      id: 'seg-1',
      text: '嗯,今天聊聊剪辑。',
      start: 0,
      end: 4,
      words: [
        { text: '嗯', start: 0.2, end: 0.6 },
        { text: '今天', start: 0.6, end: 1.6 },
        { text: '那个', start: 1.6, end: 2.0 },
        { text: '剪辑', start: 2.0, end: 3.4 },
      ],
    };
    const ops = planFillerCuts([seg]);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].op, 'cut');
    assert.equal(ops[0].start, 0.2 - CUT_MARGIN_SEC);
    assert.equal(ops[0].end, 0.6 + CUT_MARGIN_SEC);
    assert.equal(ops[1].start, 1.6 - CUT_MARGIN_SEC);
  });

  it('无词级时间戳:整句恰为口头禅时剪整句', () => {
    const segs = [
      { id: 'seg-1', text: '嗯。', start: 5, end: 6 },
      { id: 'seg-2', text: '正式内容', start: 6, end: 8 },
    ];
    const ops = planFillerCuts(segs);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].start, 5 - CUT_MARGIN_SEC < 0 ? 0 : 5 - CUT_MARGIN_SEC);
  });

  it('自定义词表生效', () => {
    const seg = { id: 'seg-1', text: '好的。', start: 1, end: 2 };
    const ops = planFillerCuts([seg], ['好的']);
    assert.equal(ops.length, 1);
  });
});

describe('planPauseCompression', () => {
  it('段间静音 > 0.8s → 剪掉超出保留余量的部分', () => {
    const segs = [
      { id: 'seg-1', text: 'A', start: 0, end: 2 },
      { id: 'seg-2', text: 'B', start: 3.5, end: 5 },
    ];
    const ops = planPauseCompression(segs);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, 'cut');
    // 保留 0.2s:剪 2.2 → 3.5
    assert.equal(ops[0].start, 2.2);
    assert.equal(ops[0].end, 3.5);
  });

  it('段间静音在阈值内 → 不剪', () => {
    const segs = [
      { id: 'seg-1', text: 'a', start: 0, end: 2 },
      { id: 'seg-2', text: 'b', start: 2.5, end: 4 },
    ];
    assert.deepEqual(planPauseCompression(segs), []);
  });
});
