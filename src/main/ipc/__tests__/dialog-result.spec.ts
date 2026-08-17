/**
 * 对话框返回值归一化单测
 * 职责:验证主进程 dialog IPC 对单选、多选、目录选择和保存路径返回统一结构
 * 运行:node --test --experimental-strip-types src/main/ipc/__tests__/dialog-result.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenDirectoryResult,
  normalizeOpenFileResult,
  normalizeOpenFilesResult,
  normalizeSaveFileResult,
} from '../dialog-result.ts';

describe('dialog result normalization', () => {
  it('单文件选择返回第一个路径对象', () => {
    assert.deepEqual(
      normalizeOpenFileResult(false, ['C:/videos/a.mp4', 'C:/videos/b.mp4']),
      { path: 'C:/videos/a.mp4' },
    );
  });

  it('单文件取消或空结果返回 null', () => {
    assert.equal(normalizeOpenFileResult(true, ['C:/videos/a.mp4']), null);
    assert.equal(normalizeOpenFileResult(false, []), null);
  });

  it('多文件选择返回路径数组对象', () => {
    assert.deepEqual(
      normalizeOpenFilesResult(false, ['C:/videos/a.mp4', 'C:/videos/b.mp4']),
      { paths: ['C:/videos/a.mp4', 'C:/videos/b.mp4'] },
    );
  });

  it('多文件取消或空结果返回 null', () => {
    assert.equal(normalizeOpenFilesResult(true, ['C:/videos/a.mp4']), null);
    assert.equal(normalizeOpenFilesResult(false, []), null);
  });

  it('目录选择返回第一个路径对象', () => {
    assert.deepEqual(
      normalizeOpenDirectoryResult(false, ['C:/output']),
      { path: 'C:/output' },
    );
  });

  it('保存文件返回路径对象', () => {
    assert.deepEqual(
      normalizeSaveFileResult(false, 'C:/output/result.mp4'),
      { path: 'C:/output/result.mp4' },
    );
  });

  it('保存文件取消或无路径返回 null', () => {
    assert.equal(normalizeSaveFileResult(true, 'C:/output/result.mp4'), null);
    assert.equal(normalizeSaveFileResult(false, undefined), null);
  });
});
