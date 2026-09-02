/**
 * 矩阵分组存储单测(PRD-v2.1 FR-6)
 * 运行:node --test --import tsx src/main/services/matrix/__tests__/group-store.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MatrixGroupStore, validateGroup, validateGroupName } from '../group-store';
import type { MatrixGroup } from '../types';

describe('validateGroup', () => {
  test('合法返回 null', () => {
    assert.equal(validateGroup('剧情号', ['douyin', 'kuaishou']), null);
  });

  test('空名称/空平台/非法平台报错', () => {
    assert.ok(validateGroup('', ['douyin']));
    assert.ok(validateGroup('x', []));
    assert.ok(validateGroup('x', ['douyin', 'bad' as never]));
  });
});

describe('validateGroupName', () => {
  test('超长名称报错;合法名称返回 null', () => {
    assert.ok(validateGroupName('x'.repeat(31)));
    assert.equal(validateGroupName('剧情号'), null);
  });
});

describe('MatrixGroupStore', () => {
  test('save 同名覆盖 id 稳定;list/remove/重启恢复', async () => {
    const saved: MatrixGroup[] = [];
    const store = new MatrixGroupStore({
      load: () => JSON.parse(JSON.stringify(saved)),
      persist: (list) => {
        saved.length = 0;
        saved.push(...JSON.parse(JSON.stringify(list)));
      },
    });
    const first = store.save('剧情号', ['douyin', 'kuaishou']);
    assert.equal(first.platforms.length, 2);

    const again = store.save('剧情号', ['douyin']);
    assert.equal(again.id, first.id);
    assert.equal(store.list().length, 1);

    await new Promise((r) => setTimeout(r, 2));
    store.save('知识号', ['bilibili']);
    assert.equal(store.list()[0].name, '知识号');

    assert.equal(store.remove('知识号'), true);
    assert.equal(store.remove('知识号'), false);

    const store2 = new MatrixGroupStore({ load: () => saved, persist: () => {} });
    assert.equal(store2.list().length, 1);
  });
});
