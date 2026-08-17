/**
 * TTS 进度解析纯函数单测
 * 职责:从 tts:progress 推送载荷(current/total)解析出 0-100 百分比
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/tts-progress.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtsProgress } from '../tts-progress.ts';

describe('parseTtsProgress', () => {
  it('解析合法的 current/total 为百分比', () => {
    assert.equal(parseTtsProgress({ current: 1, total: 4, stage: 'synthesizing' }), 25);
    assert.equal(parseTtsProgress({ current: 4, total: 4, stage: 'done' }), 100);
  });

  it('total 为 0 或缺失 current/total 时返回 null', () => {
    assert.equal(parseTtsProgress({ current: 1, total: 0, stage: 'x' }), null);
    assert.equal(parseTtsProgress({ current: 1, stage: 'x' }), null);
    assert.equal(parseTtsProgress({ total: 4, stage: 'x' }), null);
  });

  it('非法载荷返回 null', () => {
    assert.equal(parseTtsProgress(undefined), null);
    assert.equal(parseTtsProgress(null), null);
    assert.equal(parseTtsProgress('x'), null);
    assert.equal(parseTtsProgress({ current: 'a', total: 4 }), null);
  });

  it('current 超过 total 时封顶 100', () => {
    assert.equal(parseTtsProgress({ current: 9, total: 4, stage: 'x' }), 100);
  });
});
