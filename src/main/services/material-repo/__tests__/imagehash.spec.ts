/**
 * 感知哈希 dHash 单测(PRD-v1.7 FR-5)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dHash64, hammingDistance, isDuplicate, DHASH_PIXELS, DHASH_COLS } from '../imagehash';

/** 构造灰度图:每行从左到右递减(9,8,...,1)→ 左 > 恒右 → 全 1 位 */
function gradientPixels(): number[] {
  return Array.from({ length: DHASH_PIXELS }, (_, i) => DHASH_COLS - (i % DHASH_COLS));
}

describe('dHash64', () => {
  it('像素数不符返回空串', () => {
    assert.equal(dHash64([]), '');
    assert.equal(dHash64([1, 2, 3]), '');
  });

  it('输出 16 字符 hex', () => {
    const hash = dHash64(gradientPixels());
    assert.equal(hash.length, 16);
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it('左亮右暗 → 全 1 位(ffffffffffffffff)', () => {
    assert.equal(dHash64(gradientPixels()), 'ffffffffffffffff');
  });

  it('左暗右亮 → 全 0 位(0000000000000000)', () => {
    const pixels = Array.from(
      { length: DHASH_PIXELS },
      (_, i) => i % DHASH_COLS,
    );
    assert.equal(dHash64(pixels), '0000000000000000');
  });
});

describe('hammingDistance', () => {
  it('相同哈希 → 0', () => {
    assert.equal(hammingDistance('ffffffffffffffff', 'ffffffffffffffff'), 0);
  });

  it('单字符差异按比特计', () => {
    // f = 1111, 7 = 0111 → 1 位差异
    assert.equal(hammingDistance('ffffffffffffffff', '7fffffffffffffff'), 1);
    // f = 1111, 0 = 0000 → 4 位差异
    assert.equal(hammingDistance('ffffffffffffffff', '0fffffffffffffff'), 4);
  });

  it('长度不符返回 MAX_SAFE_INTEGER', () => {
    assert.equal(hammingDistance('ff', 'ff'), 0);
    assert.equal(hammingDistance('ffffffffffffffff', 'ff'), Number.MAX_SAFE_INTEGER);
  });
});

describe('isDuplicate', () => {
  it('距离 ≤ 8 判定为重复', () => {
    assert.equal(isDuplicate('ffffffffffffffff', 'ffffffffffffffff'), true);
    assert.equal(isDuplicate('ffffffffffffffff', 'efffffffffffffff'), true); // 1 位差
    assert.equal(isDuplicate('ffffffffffffffff', '0000000000000000'), false); // 64 位差
  });

  it('自定义阈值生效', () => {
    assert.equal(isDuplicate('ffffffffffffffff', '0fffffffffffffff', 4), true);
    assert.equal(isDuplicate('ffffffffffffffff', '0fffffffffffffff', 3), false);
  });
});
