/**
 * 素材仓库路径规范化单测
 * 职责:验证 normalizePath 的绝对路径解析与末尾分隔符处理
 * 说明:纯路径处理;不涉及文件系统
 * 运行:npm run test 或 node --test --import tsx src/main/services/material-repo/__tests__/normalize-path.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../index.ts';
import { resolve, sep } from 'path';

describe('normalizePath', () => {
  it('解析为绝对路径', () => {
    const p = normalizePath('someFolder');
    assert.equal(p, resolve('someFolder'));
  });

  it('去除末尾分隔符(便于去重比较)', () => {
    const withSep = resolve('a') + sep;
    assert.equal(normalizePath(withSep), normalizePath('a'));
  });

  it('根路径(末端分隔符)保持单斜杠不截空', () => {
    const root = normalizePath(sep);
    assert.equal(root.length > 0, true);
  });

  it('相对与绝对路径规范化后一致', () => {
    assert.equal(normalizePath(process.cwd()), normalizePath('.'));
  });
});
