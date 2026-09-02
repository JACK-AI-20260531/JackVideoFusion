/**
 * PipelineStore 单测(PRD-v2.1 FR-2)
 * 运行:node --test --import tsx src/main/services/pipeline/__tests__/store.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineStore } from '../store';
import type { Pipeline } from '../types';

/** 构造最小合法 Pipeline */
function mkPipeline(name: string): Pipeline {
  return {
    id: `pl-${name}`,
    name,
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('PipelineStore', () => {
  test('upsert/get/list/remove 与重启恢复', () => {
    const saved: Pipeline[] = [];
    const store = new PipelineStore({
      load: () => saved,
      persist: (l) => {
        saved.splice(0, saved.length, ...l);
      },
    });
    store.upsert(mkPipeline('a'));
    store.upsert(mkPipeline('b'));
    assert.equal(store.list().length, 2);
    assert.equal(store.get('pl-a')?.name, 'a');
    assert.equal(store.remove('pl-a'), true);
    assert.equal(store.remove('pl-a'), false);

    // 重启恢复:第二个实例从注入的持久化数据懒加载
    const store2 = new PipelineStore({ load: () => saved, persist: () => {} });
    assert.equal(store2.list().length, 1);
  });

  test('setRun 写入 lastRun 与 lastRunAt', () => {
    const store = new PipelineStore({ load: () => [], persist: () => {} });
    store.upsert(mkPipeline('a'));
    const ok = store.setRun('pl-a', {
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'done',
      stepStatuses: ['done'],
    });
    assert.equal(ok, true);
    assert.equal(store.get('pl-a')?.lastRun?.status, 'done');
    assert.ok(store.get('pl-a')?.lastRunAt);
  });

  test('setRun 对不存在的 id 返回 false', () => {
    const store = new PipelineStore({ load: () => [], persist: () => {} });
    assert.equal(
      store.setRun('pl-x', { startedAt: '2026-01-01T00:00:00.000Z', status: 'done', stepStatuses: [] }),
      false,
    );
  });
});
