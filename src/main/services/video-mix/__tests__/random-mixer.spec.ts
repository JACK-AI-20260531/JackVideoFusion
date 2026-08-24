/**
 * 随机素材混剪(runRandomMix)编排单测
 * 职责:通过注入 mock ffmpeg/repo/taskQueue,验证参数校验、素材抽取、切分、
 *      拼接、水印/字幕条件应用、checkpoint 断点续渲染与取消等编排决策逻辑
 * 说明:不依赖真实 ffmpeg 进程与真实素材仓库
 * 运行:npm run test 或 node --test --import tsx src/main/services/video-mix/__tests__/random-mixer.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRandomMix, type RandomMixDeps } from '../random-mixer.ts';
import type { FFmpegService } from '../../ffmpeg';
import type { MaterialRepo, MaterialMeta } from '../../material-repo';
import type { TaskQueue, Checkpoint } from '../../task-queue/types';
import type { MixParams } from '../types';
import { CancelToken } from '../../ffmpeg/types';

let tempDir = '';

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jvf-vmix-'));
});
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface Ctx {
  calls: string[];
  ffmpeg: FFmpegService;
  repo: MaterialRepo;
  checkpoints: Map<string, Checkpoint>;
  queue: TaskQueue;
  deps: RandomMixDeps;
}

/** 构造 mock 依赖:记录调用、可配置素材与预置 checkpoint */
function makeCtx(
  over: {
    videos?: string[][];
    splitSegs?: string[];
    resolveKey?: string;
  } = {},
): Ctx {
  const calls: string[] = [];
  const checkpoints = new Map<string, Checkpoint>();
  const videos: string[][] = over.videos ?? [['/v1.mp4', '/v2.mp4']];

  const ffmpeg = {
    probe: async () => ({ durationSec: 12, filePath: '/x' }),
    split: async (_in: string, _s: number, _dir: string, _o: unknown) => {
      calls.push('split');
      return over.splitSegs ?? [`${_dir}/seg0.mp4`];
    },
    concat: async () => {
      calls.push('concat');
    },
    transcode: async () => {
      calls.push('transcode');
    },
    applyWatermark: async () => {
      calls.push('applyWatermark');
    },
    burnSubtitle: async () => {
      calls.push('burnSubtitle');
    },
  } as unknown as FFmpegService;

  const repo = {
    scanFolder: async () => [],
    pickFromFolder: (folderId: string, count: number): MaterialMeta[] => {
      const pool = videos[Number(folderId)] ?? [];
      return pool.slice(0, count).map((p, i) => ({
        id: `${folderId}-${i}`,
        name: p.split('/').pop() ?? p,
        kind: 'video',
        path: p,
        sizeBytes: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        folderId,
      }));
    },
  } as unknown as MaterialRepo;

  const queue = {
    loadCheckpoint: (id: string) => checkpoints.get(id) ?? null,
    saveCheckpoint: (taskId: string, step: string, progress: number, ctx: unknown) => {
      calls.push(`checkpoint:${step}`);
      checkpoints.set(taskId, { taskId, step, progress, context: ctx, savedAt: '' });
    },
  } as unknown as TaskQueue;

  const deps: RandomMixDeps = { userDataDir: tempDir, ffmpeg, repo, queue };
  return { calls, ffmpeg, repo, checkpoints, queue, deps };
}

function params(over: Partial<MixParams> = {}): MixParams {
  return {
    mode: 'random',
    folderIds: ['0'],
    perFolderCount: 2,
    resolution: '1080p',
    keepOriginalQuality: false,
    outputDir: tempDir,
    outputName: 'out.mp4',
    ...over,
  };
}

const token = new CancelToken('t');

describe('runRandomMix 参数校验', () => {
  it('folderIds 为空时抛错', async () => {
    const { deps } = makeCtx();
    await assert.rejects(() => runRandomMix(params({ folderIds: [] }), 't1', token, deps), /folderIds 不能为空/);
  });

  it('perFolderCount <= 0 时抛错', async () => {
    const { deps } = makeCtx();
    await assert.rejects(() => runRandomMix(params({ perFolderCount: 0 }), 't1', token, deps), /perFolderCount 必须 > 0/);
  });
});

describe('runRandomMix 主流程', () => {
  it('正常完成:拼接+转码输出,返回时长与片段数', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4', '/b.mp4']] });
    const result = await runRandomMix(params({ keepOriginalQuality: true }), 't1', token, deps);
    assert.equal(calls.includes('concat'), true);
    assert.equal(calls.includes('transcode'), true);
    assert.equal(result.durationSec, 12);
    assert.equal(result.segmentCount, 2);
    assert.equal(result.outputPath, join(tempDir, 'out.mp4'));
  });

  it('未抽取出任何视频片段时抛错', async () => {
    const { deps } = makeCtx({ videos: [[]] });
    await assert.rejects(() => runRandomMix(params(), 't1', token, deps), /未抽取出任何视频片段/);
  });

  it('多个文件夹各抽取片段并全部拼接', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4'], ['/b.mp4']] });
    const result = await runRandomMix(params({ folderIds: ['0', '1'], keepOriginalQuality: true }), 't1', token, deps);
    assert.equal(result.segmentCount, 2);
    assert.equal(calls.includes('concat'), true);
  });
});

describe('runRandomMix 切分/水印/字幕', () => {
  it('segmentSec>0 时调用 split 并收集分段', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']], splitSegs: ['/s0.mp4', '/s1.mp4'] });
    const result = await runRandomMix(params({ segmentSec: 5, keepOriginalQuality: true }), 't1', token, deps);
    assert.equal(calls.includes('split'), true);
    assert.equal(result.segmentCount, 2);
  });

  it('启用图片水印时调用 applyWatermark', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']] });
    await runRandomMix(
      params({
        keepOriginalQuality: true,
        watermark: { enabled: true, type: 'image', content: '/wm.png', position: 'center' },
      }),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('applyWatermark'), true);
  });

  it('启用文本水印时调用 applyWatermark', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']] });
    await runRandomMix(
      params({
        keepOriginalQuality: true,
        watermark: { enabled: true, type: 'text', content: '水印', position: 'bottom-right' },
      }),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('applyWatermark'), true);
  });

  it('禁用水印时不调用 applyWatermark', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']] });
    await runRandomMix(
      params({ keepOriginalQuality: true, watermark: { enabled: false, type: 'text', content: '', position: 'center' } }),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('applyWatermark'), false);
  });

  it('提供字幕时调用 burnSubtitle', async () => {
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']] });
    await runRandomMix(
      params({ keepOriginalQuality: true, subtitle: { srtPath: '/sub.srt' } }),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('burnSubtitle'), true);
  });
});

describe('runRandomMix checkpoint 断点续渲染', () => {
  it('random-finalize checkpoint 时直接返回不重跑', async () => {
    const finalPath = join(tempDir, 'existing-final.mp4');
    writeFileSync(finalPath, 'x');
    const { deps } = makeCtx({ videos: [['/a.mp4']] });
    deps.queue!.loadCheckpoint = () => ({
      taskId: 't1',
      step: 'random-finalize',
      progress: 100,
      context: { finalPath },
      savedAt: '',
    });
    const result = await runRandomMix(params(), 't1', token, deps);
    assert.equal(result.outputPath, finalPath);
    assert.equal(result.segmentCount, 0);
  });

  it('random-subtitle checkpoint 时跳过后续处理的素材抽取,仅转码到最终输出', async () => {
    const currentFile = join(tempDir, 'subtitle-stage.mp4');
    writeFileSync(currentFile, 'x');
    const { deps, calls } = makeCtx({ videos: [['/a.mp4']] });
    (deps.queue as TaskQueue).loadCheckpoint = () => ({
      taskId: 't1',
      step: 'random-subtitle',
      progress: 85,
      context: { currentFile },
      savedAt: '',
    });
    await runRandomMix(params(), 't1', token, deps);
    // 从 checkpoint 续渲染:不再 concat/split,直接 transcode
    assert.equal(calls.includes('split'), false);
    assert.equal(calls.includes('concat'), false);
    assert.equal(calls.includes('transcode'), true);
  });
});

describe('runRandomMix 取消', () => {
  it('已取消令牌立即抛取消错误', async () => {
    const { deps } = makeCtx({ videos: [['/a.mp4']] });
    const cancelled = new CancelToken('t');
    cancelled.cancel('stop');
    await assert.rejects(() => runRandomMix(params(), 't1', cancelled, deps), /已取消/);
  });
});
