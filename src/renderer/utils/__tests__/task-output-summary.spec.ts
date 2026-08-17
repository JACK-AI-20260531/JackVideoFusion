/**
 * 任务输出摘要单测
 * 职责:验证任务结果和错误信息能转换为用户可读的短文本
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/task-output-summary.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTaskOutput } from '../task-output-summary.ts';

describe('summarizeTaskOutput', () => {
  it('优先显示视频输出路径', () => {
    assert.equal(
      summarizeTaskOutput({ outputPath: 'C:/out/final.mp4' }),
      '输出:C:/out/final.mp4',
    );
  });

  it('显示音频和字幕输出路径', () => {
    assert.equal(
      summarizeTaskOutput({ audioPath: 'C:/out/audio.wav', srtPath: 'C:/out/audio.srt' }),
      '音频:C:/out/audio.wav | 字幕:C:/out/audio.srt',
    );
  });

  it('显示字符串结果', () => {
    assert.equal(summarizeTaskOutput('C:/out/subtitle.srt'), '输出:C:/out/subtitle.srt');
  });

  it('显示数组结果数量', () => {
    assert.equal(summarizeTaskOutput(['第一段', '第二段']), '结果:2 项');
  });

  it('显示失败原因', () => {
    assert.equal(summarizeTaskOutput(undefined, 'FFmpeg 不可用'), '错误:FFmpeg 不可用');
  });

  it('没有可读输出时返回空字符串', () => {
    assert.equal(summarizeTaskOutput(undefined), '');
    assert.equal(summarizeTaskOutput({}), '');
  });
});
