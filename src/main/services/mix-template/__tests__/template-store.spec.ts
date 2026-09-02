/**
 * 混剪参数模板存储单测(PRD-v2.1 FR-1)
 * 运行:node --test --import tsx src/main/services/mix-template/__tests__/template-store.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MixTemplateStore, validateTemplateInput } from '../template-store.ts';
import type { MixParams } from '../../video-mix/types.ts';
import type { MixTemplate } from '../types.ts';

/** 最小合法 MixParams(供各用例复用) */
function validParams() {
  return {
    mode: 'random' as const,
    folderIds: ['f1', 'f2'],
    perFolderCount: 3,
    resolution: '1080p' as const,
    keepOriginalQuality: false,
  };
}

/** 内存持久化工厂(load/persist 注入,绕开 electron) */
function memoryStore() {
  const saved: { data: MixTemplate[] } = { data: [] };
  const store = new MixTemplateStore({
    load: () => JSON.parse(JSON.stringify(saved.data)),
    persist: (list) => {
      saved.data = JSON.parse(JSON.stringify(list));
    },
  });
  return { store, saved };
}

describe('validateTemplateInput', () => {
  test('合法输入返回 null', () => {
    assert.equal(validateTemplateInput('剧情号', validParams()), null);
  });

  test('空名称/超长名称/非法 mode/空 folderIds 报错', () => {
    assert.ok(validateTemplateInput('', validParams()));
    assert.ok(validateTemplateInput('x'.repeat(51), validParams()));
    assert.ok(validateTemplateInput('t', { ...validParams(), mode: 'bad' as never }));
    assert.ok(validateTemplateInput('t', { ...validParams(), folderIds: [] }));
    assert.ok(validateTemplateInput('t', undefined as never));
  });
});

describe('MixTemplateStore', () => {
  test('save 后 get/listMeta 可取回,同名覆盖且 id 稳定', () => {
    const { store } = memoryStore();
    const first = store.save('剧情号', validParams(), '描述A');
    assert.equal(first.name, '剧情号');
    assert.equal(store.get('剧情号')?.params.folderIds.length, 2);

    // 同名覆盖:id 不变,updatedAt 刷新
    const again = store.save('剧情号', { ...validParams(), perFolderCount: 5 });
    assert.equal(again.id, first.id);
    assert.equal(again.params.perFolderCount, 5);
    assert.equal(store.listMeta().length, 1);
  });

  test('listMeta 按更新时间降序,且不含 params', async () => {
    const { store } = memoryStore();
    store.save('a', validParams());
    // 隔 2ms 再保存,保证 updatedAt 可比较(ISO 毫秒精度)
    await new Promise((r) => setTimeout(r, 2));
    store.save('b', validParams());
    const metas = store.listMeta();
    assert.equal(metas.length, 2);
    assert.equal(metas[0].name, 'b'); // 后保存的在前
    assert.equal('params' in metas[0], false);
  });

  test('remove 删除成功返回 true,不存在返回 false', () => {
    const { store } = memoryStore();
    store.save('a', validParams());
    assert.equal(store.remove('a'), true);
    assert.equal(store.get('a'), null);
    assert.equal(store.remove('a'), false);
  });

  test('重启恢复:load 注入的数据懒加载后可见', () => {
    const { store, saved } = memoryStore();
    store.save('a', validParams());

    const store2 = new MixTemplateStore({ load: () => saved.data, persist: () => {} });
    assert.ok(store2.get('a'));
  });
});
