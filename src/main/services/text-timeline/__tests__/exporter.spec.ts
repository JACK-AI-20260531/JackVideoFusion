/**
 * EDL 导出器单测(PRD-文本即时间线 v2.0 M3 / U3)
 * ffmpeg I/O 全部 mock,校验裁剪参数/拼接顺序/一致性结果
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TextTimelineExporter,
  validateExportConsistency,
} from '../exporter';
import { createEdl, applyCut, applyMute } from '../edl';

describe('validateExportConsistency', () => {
  it('容差内一致,超出容差不一致', () => {
    assert.equal(validateExportConsistency(90, 90.3), true);
    assert.equal(validateExportConsistency(90, 90.6), false);
    assert.equal(validateExportConsistency(90, NaN), false);
  });
});

describe('TextTimelineExporter.exportEdl', () => {
  it('按 EDL 逐段裁剪(静音段丢音频)并拼接,返回一致性结果', async () => {
    // EDL:[0,40) 保留 + [50,100) 静音
    let edl = applyCut(createEdl('a.mp4', 100), 40, 50);
    edl = applyMute(edl, 50, 60);
    const trims: { input: string; output: string; opts: { startSec: number; endSec: number; muteAudio?: boolean } }[] = [];
    let concatInput: string[] | null = null;
    const exporter = new TextTimelineExporter({
      trim: async (input, output, opts) => {
        trims.push({ input, output, opts });
        return output;
      },
      concat: async (inputs, output) => {
        concatInput = [...inputs];
        return output;
      },
      getDuration: async () => 90.2,
    });

    const result = await exporter.exportEdl({
      videoPath: 'src.mp4',
      edl,
      outputDir: 'out',
      outputName: 'final.mp4',
    });

    // 静音拆分后共 3 段:[0,40) 正常 / [50,60) 静音 / [60,100) 正常
    assert.equal(trims.length, 3);
    assert.equal(trims[0].opts.startSec, 0);
    assert.equal(trims[0].opts.endSec, 40);
    assert.equal(trims[0].opts.muteAudio, false);
    assert.equal(trims[1].opts.startSec, 50);
    assert.equal(trims[1].opts.endSec, 60);
    assert.equal(trims[1].opts.muteAudio, true);
    assert.equal(trims[2].opts.startSec, 60);
    assert.equal(trims[2].opts.endSec, 100);
    assert.equal(trims[2].opts.muteAudio, false);
    // 拼接按片段顺序
    assert.deepEqual(concatInput, [trims[0].output, trims[1].output, trims[2].output]);
    // 一致性:期望 90s,实际 90.2s,容差内
    assert.equal(result.expectedSec, 90);
    assert.equal(result.actualSec, 90.2);
    assert.equal(result.consistent, true);
    assert.equal(result.clipCount, 3);
    assert.equal(result.mutedClipCount, 1);
  });

  it('输出时长偏差超容差 → consistent=false', async () => {
    const exporter = new TextTimelineExporter({
      trim: async (_i, o) => o,
      concat: async (_inputs, output) => output,
      getDuration: async () => 80,
    });
    const result = await exporter.exportEdl({
      videoPath: 'src.mp4',
      edl: createEdl('src.mp4', 100),
      outputDir: 'out',
    });
    assert.equal(result.consistent, false);
  });

  it('空 EDL 抛错', async () => {
    const exporter = new TextTimelineExporter({});
    await assert.rejects(
      () =>
        exporter.exportEdl({
          videoPath: 'src.mp4',
          edl: { sourcePath: 'src.mp4', durationSec: 100, clips: [] },
          outputDir: 'out',
        }),
      /无保留片段/,
    );
  });
});
