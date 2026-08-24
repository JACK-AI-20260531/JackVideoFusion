/**
 * 素材匹配编排单测
 * 职责:通过注入 mock repo/clip/llm/ffmpeg,验证 matchMaterials 的素材扫描、候选帧池、
 *      最佳匹配选择(偏好未用素材)、语义加权与异常分支
 * 说明:不依赖真实 CLIP/LLM/ffmpeg 服务
 * 运行:npm run test 或 node --test --import tsx src/main/services/film-dub-clone/__tests__/material-matcher.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchMaterials, type MatchMaterialsDeps } from '../material-matcher.ts';
import type { MaterialRepo, MaterialMeta } from '../../material-repo';
import { CancelToken } from '../../ffmpeg/types';
import type { TaskQueue } from '../../task-queue/types';
import type { Shot } from '../../shot-detect';
import type { RhythmPattern, ShotMatch } from '../types';
import type { IClipService, Embedding } from '../../clip';

interface MockClipOpts {
  /** path → 该候选帧的视觉分(用于余弦相似度) */
  scoresByPath: Record<string, number>;
  /** embedText 返回的向量(用于验证语义加权) */
  textVec?: number[];
}

/** 构造可控相似度的 mock CLIP:cosineSimilarity 返回候选路径映射的分 */
function makeMockClip(opts: MockClipOpts): IClipService {
  const registry: string[] = [];
  const idxOf = (p: string): number => {
    let i = registry.indexOf(p);
    if (i < 0) {
      registry.push(p);
      i = registry.length - 1;
    }
    return i;
  };
  return {
    isRealModel: false,
    async loadModel() { return undefined; },
    async embedText() {
      const v = new Float32Array([opts.textVec && opts.textVec[0] !== undefined ? opts.textVec[0] : 0, 0]);
      return v;
    },
    async embedImage(p: string) { return new Float32Array([idxOf(p), 0]); },
    async embedVideoFrame(p: string, t: number) { return new Float32Array([idxOf(p), t]); },
    cosineSimilarity(_a: Embedding, b: Embedding) {
      const path = registry[b[0]];
      return opts.scoresByPath[path] ?? 0;
    },
    async match() { return []; },
  };
}

function makeMeta(path: string, durationSec = 20): MaterialMeta {
  return {
    id: path,
    folderId: 'f0',
    path,
    name: path.split('/').pop() ?? path,
    kind: 'video',
    durationSec,
    createdAt: '',
  };
}

interface Ctx {
  deps: MatchMaterialsDeps;
}

function makeCtx(
  videos: Array<{ path: string; durationSec?: number }>,
  clipOpts: MockClipOpts,
  llmKeywords?: string[],
): Ctx {
  const materials = videos.map((v) => makeMeta(v.path, v.durationSec));
  const deps: MatchMaterialsDeps = {
    repo: {
      scanFolder: async () => [],
      listMaterials: () => materials,
    } as unknown as MaterialRepo,
    getClip: () => Promise.resolve(makeMockClip(clipOpts)),
    llm: {
      extractKeywords: async () => ({ keywords: llmKeywords ?? [], raw: '' }),
    },
    ffmpeg: {
      probe: async () => ({ durationSec: 20, filePath: '' }),
    } as never,
  };
  return { deps };
}

function rhythm(shots: Shot[]): RhythmPattern {
  return {
    referenceVideoPath: '/ref.mp4',
    shots,
    avgShotDuration: 10,
    totalDuration: 30,
    cutCount: shots.length - 1,
  };
}

function shot(start: number, end: number): Shot {
  return { index: 0, startTime: start, endTime: end, duration: end - start };
}

const mkQueue = (): TaskQueue => ({
  enqueue: () => '', pause: () => undefined, resume: () => undefined, cancel: () => undefined,
  list: () => [], get: () => null, saveCheckpoint: () => undefined, loadCheckpoint: () => null,
  complete: () => undefined, fail: () => undefined, updateProgress: () => undefined,
  setConcurrency: () => undefined, restoreOnStartup: () => undefined,
} as unknown as TaskQueue);

const token = new CancelToken('t');

describe('matchMaterials 校验', () => {
  it('folderId 为空时抛错', async () => {
    const { deps } = makeCtx([{ path: '/m.mp4' }], { scoresByPath: {} });
    await assert.rejects(() => matchMaterials(rhythm([shot(0, 10)]), '', '文案', mkQueue(), 't1', token, deps), /folderId 为空/);
  });

  it('参考镜头序列为空时抛错', async () => {
    const { deps } = makeCtx([{ path: '/m.mp4' }], { scoresByPath: {} });
    await assert.rejects(() => matchMaterials(rhythm([]), 'f0', '文案', mkQueue(), 't1', token, deps), /参考镜头序列为空/);
  });

  it('文件夹无视频素材时抛错', async () => {
    const { deps } = makeCtx([], { scoresByPath: {} });
    await assert.rejects(() => matchMaterials(rhythm([shot(0, 10)]), 'f0', '文案', mkQueue(), 't1', token, deps), /无视频素材/);
  });
});

describe('matchMaterials 匹配选择', () => {
  it('选择视觉分最高的素材帧', async () => {
    const { deps } = makeCtx(
      [{ path: '/m1.mp4' }, { path: '/m2.mp4' }],
      { scoresByPath: { '/m1.mp4': 0.3, '/m2.mp4': 0.9 } },
    );
    const matches = await matchMaterials(rhythm([shot(0, 10)]), 'f0', '', mkQueue(), 't1', token, deps);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].materialPath, '/m2.mp4');
    assert.equal(matches[0].shot.startTime, 0);
  });

  it('多镜头时偏好未用过的素材(多样性),即使已用素材分数更高', async () => {
    // m1 分数最高;快门0 用 m1,快门1 应改用 m2(未用)以提升多样性
    const { deps } = makeCtx(
      [{ path: '/m1.mp4' }, { path: '/m2.mp4' }],
      { scoresByPath: { '/m1.mp4': 1.0, '/m2.mp4': 0.6 } },
    );
    const matches = await matchMaterials(
      rhythm([shot(0, 10), shot(10, 20)]),
      'f0',
      '',
      mkQueue(),
      't1',
      token,
      deps,
    );
    assert.equal(matches.length, 2);
    assert.equal(matches[0].materialPath, '/m1.mp4');
    assert.equal(matches[1].materialPath, '/m2.mp4', '第二个镜头应改用未用过的素材');
  });

  it('素材全被用过时降级复用已用素材', async () => {
    // 仅一个素材,两个镜头 → 第二个镜头复用同一个素材
    const { deps } = makeCtx(
      [{ path: '/only.mp4' }],
      { scoresByPath: { '/only.mp4': 0.8 } },
    );
    const matches = await matchMaterials(
      rhythm([shot(0, 10), shot(10, 20)]),
      'f0',
      '',
      mkQueue(),
      't1',
      token,
      deps,
    );
    assert.equal(matches.length, 2);
    assert.equal(matches[1].materialPath, '/only.mp4');
  });
});

describe('matchMaterials 语义加权', () => {
  it('提供文案且 LLM 有关键词时启用语义(调用 embedText)', async () => {
    let embedTextCalled = false;
    const clip = makeMockClip({ scoresByPath: { '/m1.mp4': 0.5 } });
    const origEmbedText = clip.embedText.bind(clip);
    clip.embedText = async (t) => {
      embedTextCalled = true;
      return origEmbedText(t);
    };
    const { deps } = makeCtx([{ path: '/m1.mp4' }], { scoresByPath: { '/m1.mp4': 0.5 } }, ['猫', '风景']);
    deps.getClip = () => Promise.resolve(clip);
    await matchMaterials(rhythm([shot(0, 10)]), 'f0', '讲猫和风景', mkQueue(), 't1', token, deps);
    assert.equal(embedTextCalled, true);
  });

  it('文案为空时不调用 LLM', async () => {
    let llmCalled = false;
    const { deps } = makeCtx([{ path: '/m1.mp4' }], { scoresByPath: { '/m1.mp4': 0.5 } });
    deps.llm = {
      extractKeywords: async () => {
        llmCalled = true;
        return { keywords: ['x'], raw: '' };
      },
    };
    await matchMaterials(rhythm([shot(0, 10)]), 'f0', '', mkQueue(), 't1', token, deps);
    assert.equal(llmCalled, false);
  });
});
