/**
 * 剪贴板复制纯函数单测
 * 职责:验证复制前对空文本的防护(isCopyable 判定,以及空文本短路返回 false)
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/clipboard.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCopyable, shouldCopy } from '../clipboard.ts';

describe('isCopyable', () => {
  it('非空文本可复制', () => {
    assert.equal(isCopyable('C:/out/a.mp4'), true);
    assert.equal(isCopyable('任意文本'), true);
  });

  it('空/纯空白文本不可复制', () => {
    assert.equal(isCopyable(''), false);
    assert.equal(isCopyable('   '), false);
    assert.equal(isCopyable(null), false);
    assert.equal(isCopyable(undefined), false);
  });
});

describe('shouldCopy', () => {
  it('空文本返回 false 且不抛错(短路,不触发剪贴板)', async () => {
    assert.equal(await shouldCopy(''), false);
    assert.equal(await shouldCopy('   '), false);
    assert.equal(await shouldCopy(null), false);
    await assert.doesNotReject(async () => {
      await shouldCopy('');
    });
  });
});
