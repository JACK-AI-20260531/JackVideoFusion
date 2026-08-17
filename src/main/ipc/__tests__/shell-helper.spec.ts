/**
 * shell 路径提取纯函数单测
 * 职责:验证从 IPC 载荷中安全提取要打开/定位的文件路径
 * 运行:node --test --experimental-strip-types src/main/ipc/__tests__/shell-helper.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPath } from '../shell-helper.ts';

describe('extractPath', () => {
  it('从 { path } 载荷提取路径', () => {
    assert.equal(extractPath({ path: 'C:/out/a.mp4' }), 'C:/out/a.mp4');
  });

  it('直接传字符串路径', () => {
    assert.equal(extractPath('C:/out/a.mp4'), 'C:/out/a.mp4');
  });

  it('缺 path 或为空时返回空字符串', () => {
    assert.equal(extractPath({}), '');
    assert.equal(extractPath({ path: '' }), '');
    assert.equal(extractPath(null), '');
    assert.equal(extractPath(undefined), '');
    assert.equal(extractPath(123), '');
  });
});
