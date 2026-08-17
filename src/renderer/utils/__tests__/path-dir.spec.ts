/**
 * 目录提取纯函数单测
 * 职责:验证从产出文件路径提取所在目录(跨平台分隔符)
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/path-dir.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDirOf } from '../path-dir.ts';

describe('resolveDirOf', () => {
  it('提取 POSIX 路径所在目录(去掉下级文件名)', () => {
    assert.equal(resolveDirOf('/out/a.mp3'), '/out');
  });

  it('提取 Windows 路径所在目录', () => {
    assert.equal(resolveDirOf('C:\\out\\a.mp3'), 'C:\\out');
    assert.equal(resolveDirOf('C:/out/a.mp3'), 'C:/out');
  });

  it('无目录信息时返回空字符串', () => {
    assert.equal(resolveDirOf('a.mp3'), '');
    assert.equal(resolveDirOf(''), '');
    assert.equal(resolveDirOf(null), '');
    assert.equal(resolveDirOf(undefined), '');
  });
});
