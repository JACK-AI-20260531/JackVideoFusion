/**
 * 素材语义索引存储单测(PRD-v2.1 FR-4)
 * 运行:node --test --import tsx src/main/services/semantic/__tests__/index-store.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticIndexStore } from '../index-store';
import type { IndexedMaterial } from '../types';

/** 构造最小索引条目 */
function mkEntry(id: string): IndexedMaterial {
  return {
    materialId: id,
    path: `${id}.mp4`,
    folderId: 'f1',
    name: id,
    vector: [1, 0],
    tags: ['海边'],
    indexedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SemanticIndexStore', () => {
  test('set/get/list/remove + 重启恢复', () => {
    const saved: IndexedMaterial[] = [];
    const store = new SemanticIndexStore({
      load: () => saved,
      persist: (m) => {
        saved.length = 0;
        saved.push(...m);
      },
    });
    store.set(mkEntry('m1'));
    store.set(mkEntry('m2'));
    assert.equal(store.size(), 2);
    assert.equal(store.get('m1')?.path, 'm1.mp4');
    store.remove('m1');
    assert.equal(store.get('m1'), null);

    // 重启恢复:第二个实例从注入的持久化数据懒加载
    const store2 = new SemanticIndexStore({ load: () => saved, persist: () => {} });
    assert.equal(store2.size(), 1);
  });

  test('set 同 key 覆盖;remove 不存在的 key 静默', () => {
    const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
    store.set(mkEntry('m1'));
    store.set(mkEntry('m1'));
    assert.equal(store.size(), 1);
    assert.equal(store.has('m1'), true);
    store.remove('m1');
    assert.equal(store.has('m1'), false);
    store.remove('m1'); // 不存在,不抛错
  });

  test('removeWhere 按条件批量清理并返回条数(删除文件夹/重扫联动)', () => {
    const store = new SemanticIndexStore({ load: () => [], persist: () => {} });
    store.set(mkEntry('m1'));
    store.set(mkEntry('m2'));
    store.set({
      ...mkEntry('m3'),
      materialId: 'm3',
      folderId: 'f2',
    });
    // 删除 f1 文件夹:清掉其下全部索引
    const removed = store.removeWhere((e) => e.folderId === 'f1');
    assert.equal(removed, 2);
    assert.equal(store.get('m3')?.folderId, 'f2');
    // 无匹配返回 0
    assert.equal(store.removeWhere(() => false), 0);
  });
});
