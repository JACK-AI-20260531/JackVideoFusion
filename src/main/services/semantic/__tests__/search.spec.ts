/**
 * 语义搜索单测(PRD-v2.1 FR-4)
 * 运行:node --test --import tsx src/main/services/semantic/__tests__/search.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { semanticSearch } from '../search';
import { SemanticIndexStore } from '../index-store';

/** mock CLIP:文本向量恒为 [1,0] */
const clip = { embedText: async () => [1, 0] };

/** 构造含 near/far 两条索引的 store */
function seedStore(): SemanticIndexStore {
  const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
  store.set({
    materialId: 'near',
    path: 'near.mp4',
    folderId: 'f1',
    name: 'near',
    vector: [1, 0],
    tags: [],
    indexedAt: '2026-01-01T00:00:00.000Z',
  });
  store.set({
    materialId: 'far',
    path: 'far.mp4',
    folderId: 'f1',
    name: 'far',
    vector: [0, 1],
    tags: [],
    indexedAt: '2026-01-01T00:00:00.000Z',
  });
  return store;
}

describe('semanticSearch', () => {
  test('Top-K + 阈值过滤,降序', async () => {
    const hits = await semanticSearch('海边', {
      clip,
      store: seedStore(),
      topK: 10,
      threshold: 0.25,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].materialId, 'near');
    assert.equal(hits[0].score, 1);
  });

  test('k=1 只返回最高一条', async () => {
    const store = seedStore();
    store.set({
      materialId: 'near2',
      path: 'near2.mp4',
      folderId: 'f2',
      name: 'near2',
      vector: [0.9, 0.1],
      tags: [],
      indexedAt: '2026-01-01T00:00:00.000Z',
    });
    const hits = await semanticSearch('x', { clip, store, topK: 1, threshold: 0.25 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].materialId, 'near');
  });

  test('空查询报错', async () => {
    await assert.rejects(
      () => semanticSearch('  ', { clip, store: seedStore() }),
      /查询文本不能为空/,
    );
  });
});
