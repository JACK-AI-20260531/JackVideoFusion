/**
 * 产物清单导出工具单测
 * 职责:验证批量产物路径清单文本构建与默认文件名生成
 * 运行:node --test --import tsx src/renderer/utils/__tests__/export-manifest.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestText, createManifestFilename } from '../export-manifest.ts';

describe('buildManifestText', () => {
  it('按每行一个路径构建清单并复用路径去重规则', () => {
    assert.equal(
      buildManifestText(['C:/out/a.mp4', '', undefined, 'C:/out/b.mp4', 'C:/out/a.mp4']),
      'C:/out/a.mp4\nC:/out/b.mp4',
    );
  });
});

describe('createManifestFilename', () => {
  it('生成带场景前缀与时间戳的 txt 文件名', () => {
    assert.equal(createManifestFilename('ai-slice', 1787064168123), 'ai-slice-manifest-1787064168123.txt');
  });
});
