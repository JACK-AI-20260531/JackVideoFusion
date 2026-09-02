/**
 * 语义相似度纯函数单测(PRD-v2.1 FR-4/5)
 * 运行:node --test --import tsx src/main/services/semantic/__tests__/similarity.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, topK, argmaxTag, findDuplicateGroups } from '../similarity';
import type { IndexedMaterial, ScoredMaterial, TagGroup } from '../types';

describe('cosine', () => {
  test('同向为 1,反向为 -1,正交为 0', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [-1, 0]), -1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
  });

  test('零向量返回 0(不抛错)', () => {
    assert.equal(cosine([0, 0], [1, 0]), 0);
  });
});

describe('topK', () => {
  const items: ScoredMaterial[] = [
    { materialId: 'a', path: 'p-a', folderId: 'f1', name: 'a', score: 0.9 },
    { materialId: 'b', path: 'p-b', folderId: 'f1', name: 'b', score: 0.1 },
    { materialId: 'c', path: 'p-c', folderId: 'f2', name: 'c', score: 0.5 },
  ];

  test('过滤低于阈值 + 按分数降序 + 截断', () => {
    const hits = topK(items, 1, 0.25);
    assert.deepEqual(hits.map((h) => h.materialId), ['a']);
    const two = topK(items, 10, 0.25);
    assert.deepEqual(two.map((h) => h.materialId), ['a', 'c']);
  });

  test('k=0 返回空', () => {
    assert.deepEqual(topK(items, 0, 0.25), []);
  });
});

describe('argmaxTag', () => {
  const vocab: TagGroup[] = [
    { group: '场景', terms: ['室内', '海边'] },
    { group: '主体', terms: ['人物', '产品'] },
  ];

  test('每组取相似度最高的词', () => {
    // 帧向量与"海边"[1,0]最像、与"产品"[0.9,0.1]最像
    const frame = [1, 0];
    const termVectors = new Map<string, number[]>([
      ['室内', [0, 1]],
      ['海边', [1, 0]],
      ['人物', [0.7, 0.7]],
      ['产品', [0.9, 0.1]],
    ]);
    const tags = argmaxTag(frame, vocab, termVectors);
    assert.deepEqual(tags, ['海边', '产品']);
  });

  test('词向量缺失时跳过该组', () => {
    const tags = argmaxTag([1, 0], vocab, new Map());
    assert.deepEqual(tags, []);
  });
});

describe('findDuplicateGroups', () => {
  test('两两余弦 ≥ 阈值的近重复分组,先出现者为组代表', () => {
    const entries: IndexedMaterial[] = [
      { materialId: 'm1', path: 'a.mp4', folderId: 'f1', name: 'a', vector: [1, 0], tags: [], indexedAt: 't' },
      { materialId: 'm2', path: 'b.mp4', folderId: 'f1', name: 'b', vector: [0.99, 0.14], tags: [], indexedAt: 't' },
      { materialId: 'm3', path: 'c.mp4', folderId: 'f2', name: 'c', vector: [0, 1], tags: [], indexedAt: 't' },
    ];
    const groups = findDuplicateGroups(entries, 0.95);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].materialId, 'm1');
    assert.equal(groups[0].duplicates.length, 1);
    assert.equal(groups[0].duplicates[0].materialId, 'm2');
  });

  test('全部独立时返回空数组', () => {
    const entries: IndexedMaterial[] = [
      { materialId: 'm1', path: 'a.mp4', folderId: 'f1', name: 'a', vector: [1, 0], tags: [], indexedAt: 't' },
      { materialId: 'm2', path: 'b.mp4', folderId: 'f1', name: 'b', vector: [0, 1], tags: [], indexedAt: 't' },
    ];
    assert.deepEqual(findDuplicateGroups(entries, 0.95), []);
  });
});
