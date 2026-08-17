/**
 * FFmpeg 进度解析纯函数单测
 * 职责:从 ffmpeg:progress 推送载荷中解析出 taskId 与 percent
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/ffmpeg-progress.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegProgress } from '../ffmpeg-progress.ts';

describe('parseFfmpegProgress', () => {
  it('解析合法的 ffmpeg 进度', () => {
    assert.deepEqual(parseFfmpegProgress({ taskId: 'abc', stage: 'split', percent: 42 }), {
      taskId: 'abc',
      percent: 42,
    });
  });

  it('缺少 taskId 时返回 null', () => {
    assert.equal(parseFfmpegProgress({ stage: 'split', percent: 42 }), null);
  });

  it('percent 非数字时返回 null', () => {
    assert.equal(parseFfmpegProgress({ taskId: 'a', stage: 'split', percent: 'x' }), null);
  });

  it('非法载荷返回 null', () => {
    assert.equal(parseFfmpegProgress(undefined), null);
    assert.equal(parseFfmpegProgress(null), null);
    assert.equal(parseFfmpegProgress('x'), null);
  });
});
