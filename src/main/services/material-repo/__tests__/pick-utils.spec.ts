/**
 * 随机选段纯函数单测
 * 职责:验证 createRng 的种子可复现/无种子不确定性、shuffle 的原地洗牌与元素保留
 *      不依赖 electron/fs,可独立单元测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/material-repo/__tests__/pick-utils.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, shuffle } from '../pick-utils.ts';

describe('createRng', () => {
  it('同一 seed 产生完全相同序列(可复现)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    assert.deepEqual(seqA, seqB);
  });

  it('不同 seed 产生不同序列', () => {
    const a = createRng(1);
    const b = createRng(2);
    const differ = [a(), a()].some((v, i) => v !== [b(), b()][i]);
    assert.equal(differ, true);
  });

  it('输出始终在 [0, 1) 区间', () => {
    const rng = createRng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe('shuffle', () => {
  it('原地修改数组并保留全部元素(仅重排)', () => {
    const arr = [1, 2, 3, 4, 5];
    const ref = shuffle(arr, createRng(9));
    assert.equal(arr, ref); // 返回同一引用
    assert.deepEqual([...arr].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('不同 rng 产生不同洗牌结果(较大概率)', () => {
    const base = [1, 2, 3, 4, 5, 6];
    const a = shuffle([...base], createRng(1));
    const b = shuffle([...base], createRng(999));
    const shifted = a.some((v, i) => v !== b[i]);
    assert.equal(shifted, true);
  });

  it('单元素/空数组洗牌后不变', () => {
    assert.deepEqual(shuffle([1], createRng(1)), [1]);
    assert.deepEqual(shuffle([], createRng(1)), []);
  });
});
