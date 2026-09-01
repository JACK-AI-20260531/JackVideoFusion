/**
 * 素材查重分组与标签筛选单测(PRD-v1.7 FR-5)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupDuplicates } from '../dedup';
import { filterMaterials } from '../material-tags';

describe('groupDuplicates', () => {
  it('按汉明距离 ≤ 8 分组,仅保留有重复的条目', () => {
    const record = {
      'a.mp4': 'ffffffffffffffff',
      'b.mp4': 'efffffffffffffff', // 与 a 差 1 位 → 重复
      'c.mp4': '0000000000000000', // 与 a/b 差 64 位 → 独立
      'd.mp4': 'ffffffffffffffef', // 与 a 差 1 位 → 重复
    };
    const groups = groupDuplicates(record);
    // a/b/d 两两互为重复(各差 1-2 位) → 3 个分组;c 独立不出现
    assert.equal(groups.length, 3);
    const byPath = Object.fromEntries(groups.map((g) => [g.path, g]));
    assert.deepEqual(byPath['a.mp4'].duplicates.sort(), ['b.mp4', 'd.mp4']);
    assert.deepEqual(byPath['b.mp4'].duplicates.sort(), ['a.mp4', 'd.mp4']);
    assert.deepEqual(byPath['d.mp4'].duplicates.sort(), ['a.mp4', 'b.mp4']);
    assert.equal(byPath['c.mp4'], undefined);
  });

  it('无重复 → 空分组', () => {
    const groups = groupDuplicates({
      a: 'ffffffffffffffff',
      b: '0000000000000000',
    });
    assert.deepEqual(groups, []);
  });
});

describe('filterMaterials', () => {
  const materials = [
    { path: 'a.mp4', name: 'A' },
    { path: 'b.mp4', name: 'B' },
    { path: 'c.mp4', name: 'C' },
  ];
  const usage = {
    'a.mp4': { count: 5 },
    'b.mp4': { count: 1 },
  };
  const tags = {
    'a.mp4': ['搞笑'],
    'b.mp4': ['教程'],
  };

  it('按标签过滤', () => {
    const result = filterMaterials(materials, usage, tags, { tag: '搞笑' });
    assert.deepEqual(result.map((m) => m.path), ['a.mp4']);
  });

  it('按最小使用次数过滤', () => {
    const result = filterMaterials(materials, usage, tags, { minUsage: 2 });
    assert.deepEqual(result.map((m) => m.path), ['a.mp4']);
  });

  it('组合条件(标签 + 次数)', () => {
    const ok = filterMaterials(materials, usage, tags, { tag: '教程', minUsage: 1 });
    assert.deepEqual(ok.map((m) => m.path), ['b.mp4']);
    const none = filterMaterials(materials, usage, tags, { tag: '教程', minUsage: 2 });
    assert.deepEqual(none, []);
  });

  it('无条件 → 全部保留', () => {
    const result = filterMaterials(materials, usage, tags, {});
    assert.equal(result.length, 3);
  });
});
