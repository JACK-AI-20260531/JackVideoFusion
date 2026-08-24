/**
 * 节奏复刻成片合成(cloneVideo)编排单测
 * 职责:通过注入 mock ffmpeg/tts/mergeTts/mergeSegments,验证切片、拼接、TTS 配音、
 *      字幕/水印条件应用、checkpoint 续渲染与输出流程
 * 说明:不依赖真实 ffmpeg 进程与 TTS 服务
 * 运行:npm run test 或 node --test --import tsx src/main/services/film-dub-clone/__tests__/cloner-flow.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cloneVideo, type CloneVideoDeps } from '../cloner.ts';
import type { FFmpegService } from '../../ffmpeg';
import type { TaskQueue } from '../../task-queue/types';
import type { Shot } from '../../shot-detect';
import type { CloneParams, RhythmPattern, ShotMatch } from '../types';
import { CancelToken } from '../../ffmpeg/types';

let tempDir = '';

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jvf-cloner-'));
});
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface Ctx {
  deps: CloneVideoDeps;
  calls: string[];
}

function makeCtx(): Ctx {
  const calls: string[] = [];

  const ffmpeg = {
    probe: async () => ({ durationSec: 30, filePath: '/x' }),
    transcode: async () => {
      calls.push('transcode');
    },
    concat: async () => {
      calls.push('concat');
    },
    burnSubtitle: async () => {
      calls.push('burnSubtitle');
    },
    applyWatermark: async () => {
      calls.push('applyWatermark');
    },
  } as unknown as FFmpegService;

  const deps: CloneVideoDeps = {
    userDataDir: tempDir,
    ffmpeg,
    tts: {
      synthesize: async () => {
        calls.push('tts');
        return { durationSec: 3, charCount: 5, outputPath: '/out.mp3' };
      },
    },
    mergeTts: async (v, _a, o) => {
      calls.push('mergeTts');
      return o;
    },
    mergeSegments: async (_segs, o) => {
      calls.push('mergeSegments');
      return o;
    },
  };
  return { deps, calls };
}

function shot(start: number, duration: number): Shot {
  return { index: 0, startTime: start, endTime: start + duration, duration };
}

function match(i: number, materialPath: string): ShotMatch {
  return { shot: shot(i * 10, 5), materialPath, timeSec: 2 };
}

function rhythm(matches: ShotMatch[]): RhythmPattern {
  return {
    referenceVideoPath: '/ref.mp4',
    shots: matches.map((m) => m.shot),
    avgShotDuration: 5,
    totalDuration: matches.length * 5,
    cutCount: matches.length - 1,
  };
}

function params(over: Partial<CloneParams> = {}): CloneParams {
  return {
    referenceVideoPath: '/ref.mp4',
    folderId: 'f0',
    script: '',
    resolution: '1080p',
    keepOriginalQuality: true,
    generateTts: false,
    outputDir: tempDir,
    outputName: 'out.mp4',
    ...over,
  };
}

const token = new CancelToken('t');

describe('cloneVideo 校验', () => {
  it('matches 为空时抛错', async () => {
    const { deps } = makeCtx();
    await assert.rejects(() => cloneVideo([], rhythm([]), params(), makeQueue(), 't1', token, deps), /matches 为空/);
  });
});

describe('cloneVideo 基本合成流程', () => {
  it('切片+拼接+最终输出(无 TTS/字幕/水印)', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4')];
    const result = await cloneVideo(matches, rhythm(matches), params(), makeQueue(), 't1', token, deps);
    assert.equal(calls.includes('concat'), true);
    assert.equal(calls.includes('transcode'), true);
    assert.equal(result.durationSec, 30);
    assert.equal(result.segmentCount, 1);
    assert.equal(result.outputPath, join(tempDir, 'out.mp4'));
  });

  it('多片段:每个素材切片后拼接', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4'), match(1, '/m2.mp4')];
    const result = await cloneVideo(matches, rhythm(matches), params(), makeQueue(), 't1', token, deps);
    assert.equal(calls.includes('concat'), true);
    assert.equal(result.segmentCount, 2);
  });
});

describe('cloneVideo TTS 配音', () => {
  it('generateTts 时逐镜头合成+合并+混入视频', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4')];
    await cloneVideo(
      matches,
      rhythm(matches),
      params({ generateTts: true, script: '欢迎来到本期解说' }),
      makeQueue(),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('tts'), true, '应调用 tts.synthesize');
    assert.equal(calls.includes('mergeSegments'), true);
    assert.equal(calls.includes('mergeTts'), true);
  });

  it('generateTts 但文案为空时不调用 TTS', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4')];
    await cloneVideo(matches, rhythm(matches), params({ generateTts: true, script: '' }), makeQueue(), 't1', token, deps);
    assert.equal(calls.includes('tts'), false, '空文案不应调用 TTS');
  });
});

describe('cloneVideo 字幕/水印', () => {
  it('启用字幕时调用 burnSubtitle', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4')];
    await cloneVideo(matches, rhythm(matches), params({ subtitle: { enabled: true } }), makeQueue(), 't1', token, deps);
    assert.equal(calls.includes('burnSubtitle'), true);
  });

  it('启用图片水印时调用 applyWatermark', async () => {
    const { deps, calls } = makeCtx();
    const matches = [match(0, '/m1.mp4')];
    await cloneVideo(
      matches,
      rhythm(matches),
      params({ watermark: { enabled: true, type: 'image', content: '/wm.png', position: 'center' as const } }),
      makeQueue(),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('applyWatermark'), true);
  });
});

describe('cloneVideo checkpoint 续渲染', () => {
  it('finalize checkpoint 时直接返回命中文件', async () => {
    const finalPath = join(tempDir, 'existing.mp4');
    writeFileSync(finalPath, 'x');
    const { deps, calls } = makeCtx();
    const queue = makeQueue();
    (queue as TaskQueue).loadCheckpoint = () => ({
      taskId: 't1',
      step: 'film-dub-finalize',
      progress: 100,
      context: { finalPath },
      savedAt: '',
    });
    const matches = [match(0, '/m1.mp4')];
    const result = await cloneVideo(matches, rhythm(matches), params(), queue, 't1', token, deps);
    assert.equal(result.outputPath, finalPath);
    assert.equal(calls.includes('concat'), false, 'finalize 应跳过拼接');
  });
});

describe('cloneVideo 取消', () => {
  it('已取消令牌抛取消错误', async () => {
    const { deps } = makeCtx();
    const cancelled = new CancelToken('t');
    cancelled.cancel('stop');
    const matches = [match(0, '/m1.mp4')];
    await assert.rejects(() => cloneVideo(matches, rhythm(matches), params(), makeQueue(), 't1', cancelled, deps), /已取消/);
  });
});

/** 最小 mock taskQueue */
function makeQueue(): TaskQueue {
  return {
    enqueue: () => '', pause: () => undefined, resume: () => undefined, cancel: () => undefined,
    list: () => [], get: () => null, saveCheckpoint: () => undefined, loadCheckpoint: () => null,
    complete: () => undefined, fail: () => undefined, updateProgress: () => undefined,
    setConcurrency: () => undefined, restoreOnStartup: () => undefined,
  } as unknown as TaskQueue;
}
