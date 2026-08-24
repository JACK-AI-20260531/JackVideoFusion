/**
 * 文件夹音频匹配混剪(runAudioMatch)编排单测
 * 职责:通过注入 mock ffmpeg/repo/taskQueue/mergeAudio,验证抽音频、抽视频、
 *      stripAudio、合成、拼接、水印/字幕条件应用、checkpoint 续渲染等编排决策
 * 说明:不依赖真实 ffmpeg 进程与素材仓库
 * 运行:npm run test 或 node --test --import tsx src/main/services/video-mix/__tests__/audio-matcher.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runAudioMatch, type AudioMatchDeps } from '../audio-matcher.ts';
import type { FFmpegService } from '../../ffmpeg';
import type { MaterialRepo, MaterialMeta } from '../../material-repo';
import type { TaskQueue, Checkpoint } from '../../task-queue/types';
import type { MixParams } from '../types';
import { CancelToken } from '../../ffmpeg/types';

let tempDir = '';

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jvf-amatch-'));
});
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface FolderAssets {
  audio?: string;
  videos: string[];
}

/**
 * 构造 mock 依赖:每个文件夹一份音频+视频素材,记录调用
 */
function makeCtx(
  over: { folders?: FolderAssets[]; canceled?: boolean } = {},
) {
  const folders = over.folders ?? [{ audio: '/a.mp3', videos: ['/v1.mp4', '/v2.mp4'] }];
  const calls: string[] = [];
  const checkpoints = new Map<string, Checkpoint>();
  const mergeCalls: Array<{ audio: string; video: string; loop: boolean; fade: number }> = [];

  const ffmpeg = {
    probe: async () => ({ durationSec: 12, filePath: '/x' }),
    stripAudio: async () => {
      calls.push('stripAudio');
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
    pickFromFolder: (folderId: string, count: number, opts?: { kind?: string }): MaterialMeta[] => {
      const assets = folders[Number(folderId)];
      if (!assets) return [];
      if (opts?.kind === 'audio') {
        return assets.audio ? [{ id: `${folderId}-a`, name: 'a.mp3', kind: 'audio', path: assets.audio, sizeBytes: 1, createdAt: '', folderId }] : [];
      }
      return assets.videos.slice(0, count).map((p, i) => ({
        id: `${folderId}-v${i}`,
        name: p.split('/').pop() ?? p,
        kind: 'video',
        path: p,
        sizeBytes: 1,
        createdAt: '',
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

  const deps: AudioMatchDeps = {
    userDataDir: tempDir,
    ffmpeg,
    repo,
    queue,
    mergeAudio: (video, audio, output, opts) => {
      mergeCalls.push({ audio, video, loop: opts.audioLoop, fade: opts.audioFadeSec });
      return Promise.resolve(output);
    },
  };

  return { deps, calls, mergeCalls, checkpoints };
}

function params(over: Partial<MixParams> = {}): MixParams {
  return {
    mode: 'audio-match',
    folderIds: ['0'],
    perFolderCount: 2,
    resolution: '1080p',
    keepOriginalQuality: true,
    outputDir: tempDir,
    outputName: 'out.mp4',
    ...over,
  };
}

const token = new CancelToken('t');

describe('runAudioMatch 参数校验', () => {
  it('folderIds 为空时抛错', async () => {
    const { deps } = makeCtx();
    await assert.rejects(() => runAudioMatch(params({ folderIds: [] }), 't1', token, deps), /folderIds 不能为空/);
  });
});

describe('runAudioMatch 主流程', () => {
  it('单文件夹:抽音频+视频 → 合成 → 最终输出', async () => {
    const { deps, calls, mergeCalls } = makeCtx();
    const result = await runAudioMatch(params(), 't1', token, deps);
    // 应进行音频+视频合成
    assert.equal(mergeCalls.length, 1);
    assert.equal(mergeCalls[0].audio, '/a.mp3');
    assert.equal(calls.includes('transcode'), true);
    assert.equal(result.segmentCount, 1);
    assert.equal(result.durationSec, 12);
    assert.equal(result.outputPath, join(tempDir, 'out.mp4'));
  });

  it('多文件夹:各自合成后拼接', async () => {
    const { deps, calls, mergeCalls } = makeCtx({
      folders: [
        { audio: '/a1.mp3', videos: ['/v1.mp4'] },
        { audio: '/a2.mp3', videos: ['/v2.mp4'] },
      ],
    });
    const result = await runAudioMatch(params({ folderIds: ['0', '1'] }), 't1', token, deps);
    assert.equal(mergeCalls.length, 2);
    assert.equal(calls.includes('concat'), true);
    assert.equal(result.segmentCount, 2);
  });

  it('stripOriginalAudio 时调用 stripAudio', async () => {
    const { deps, calls } = makeCtx();
    await runAudioMatch(params({ stripOriginalAudio: true }), 't1', token, deps);
    assert.equal(calls.includes('stripAudio'), true);
  });

  it('音频循环与淡入淡出参数透传到合成', async () => {
    const { deps, mergeCalls } = makeCtx();
    await runAudioMatch(params({ audioLoop: true, audioFadeSec: 2 }), 't1', token, deps);
    assert.equal(mergeCalls[0].loop, true);
    assert.equal(mergeCalls[0].fade, 2);
  });
});

describe('runAudioMatch 素材缺失', () => {
  it('文件夹无音频素材时抛错', async () => {
    const { deps } = makeCtx({ folders: [{ videos: ['/v1.mp4'] }] });
    await assert.rejects(() => runAudioMatch(params(), 't1', token, deps), /无可用音频素材/);
  });

  it('文件夹无视频素材时抛错', async () => {
    const { deps } = makeCtx({ folders: [{ audio: '/a.mp3', videos: [] }] });
    await assert.rejects(() => runAudioMatch(params(), 't1', token, deps), /无可用视频素材/);
  });
});

describe('runAudioMatch 水印/字幕', () => {
  it('启用图片水印时调用 applyWatermark', async () => {
    const { deps, calls } = makeCtx();
    await runAudioMatch(
      params({ watermark: { enabled: true, type: 'image', content: '/wm.png', position: 'center' } }),
      't1',
      token,
      deps,
    );
    assert.equal(calls.includes('applyWatermark'), true);
  });

  it('提供字幕时调用 burnSubtitle', async () => {
    const { deps, calls } = makeCtx();
    await runAudioMatch(params({ subtitle: { srtPath: '/sub.srt' } }), 't1', token, deps);
    assert.equal(calls.includes('burnSubtitle'), true);
  });
});

describe('runAudioMatch checkpoint 续渲染', () => {
  it('audio-finalize checkpoint 时直接返回', async () => {
    const finalPath = join(tempDir, 'existing.mp4');
    writeFileSync(finalPath, 'x');
    const { deps, calls } = makeCtx();
    (deps.queue as TaskQueue).loadCheckpoint = () => ({
      taskId: 't1',
      step: 'audio-finalize',
      progress: 100,
      context: { finalPath },
      savedAt: '',
    });
    const result = await runAudioMatch(params(), 't1', token, deps);
    assert.equal(result.outputPath, finalPath);
    assert.equal(result.segmentCount, 0);
    assert.equal(calls.includes('concat'), false);
  });
});

describe('runAudioMatch 取消', () => {
  it('已取消令牌抛取消错误', async () => {
    const { deps } = makeCtx();
    const cancelled = new CancelToken('t');
    cancelled.cancel('stop');
    await assert.rejects(() => runAudioMatch(params(), 't1', cancelled, deps), /已取消/);
  });
});
