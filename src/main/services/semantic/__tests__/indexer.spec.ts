/**
 * 语义索引建库单测(注入 mock CLIP,绕开 ONNX)(PRD-v2.1 FR-4)
 * 运行:node --test --import tsx src/main/services/semantic/__tests__/indexer.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticIndex } from '../indexer';
import { SemanticIndexStore } from '../index-store';
import { TAG_GROUPS } from '../tag-vocab';

/** 全词表长度(供 mock 词向量构造) */
const ALL_TERMS = TAG_GROUPS.flatMap((g) => g.terms);

/** mock CLIP:帧向量 = 传入值;词向量 = 词表第 i 个单位向量 */
function mockClip(frameVec: number[]) {
  return {
    embedVideoFrame: async () => frameVec,
    embedText: async (text: string) => {
      const idx = ALL_TERMS.indexOf(text);
      const v = new Array(ALL_TERMS.length).fill(0);
      if (idx >= 0) v[idx] = 1;
      return v;
    },
  };
}

/** 构造 n 个待索引素材 */
function mkMaterials(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    path: `p${i}.mp4`,
    folderId: 'f1',
    name: `m${i}.mp4`,
  }));
}

describe('buildSemanticIndex', () => {
  test('全量建库:向量 + 每组一个标签 + 进度', async () => {
    const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
    const clip = mockClip([0.6, 0.8]);
    const progress: number[] = [];
    const res = await buildSemanticIndex({
      materials: mkMaterials(3),
      clip: clip as never,
      store,
      onProgress: (p) => progress.push(p),
    });
    assert.equal(res.built, 3);
    assert.equal(res.skipped, 0);
    assert.equal(res.failed, 0);
    assert.equal(store.size(), 3);
    const entry = store.get('m0');
    assert.ok(entry);
    assert.equal(entry.vector.length, 2);
    // 每组一个标签,共 TAG_GROUPS 组
    assert.equal(entry.tags.length, TAG_GROUPS.length);
    assert.ok(progress.includes(100));
  });

  test('断点续建:已索引素材跳过', async () => {
    const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
    const clip = mockClip([0.6, 0.8]);
    const materials = mkMaterials(2);
    await buildSemanticIndex({ materials, clip: clip as never, store });
    const res2 = await buildSemanticIndex({ materials, clip: clip as never, store });
    assert.equal(res2.built, 0);
    assert.equal(res2.skipped, 2);
  });

  test('单素材失败不中断,计入 failed', async () => {
    const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
    let calls = 0;
    const clip = {
      embedVideoFrame: async () => {
        calls++;
        if (calls === 1) throw new Error('ffmpeg 失败');
        return [1, 0];
      },
      embedText: async (t: string) => {
        const idx = ALL_TERMS.indexOf(t);
        const v = new Array(ALL_TERMS.length).fill(0);
        v[idx] = 1;
        return v;
      },
    };
    const res = await buildSemanticIndex({
      materials: mkMaterials(2),
      clip: clip as never,
      store,
    });
    assert.equal(res.built, 1);
    assert.equal(res.failed, 1);
  });
});
