/**
 * 素材扫描器纯函数单测
 * 职责:验证 detectMaterialKind 扩展名白名单识别(含大小写)、deriveFolderName 目录名推导、
 *      以及 EXT_KIND_MAP 支持类型映射
 * 注意:scanDirectory 依赖 fs/crypto IO,不在本纯函数用例内测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/material-repo/__tests__/scanner.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMaterialKind,
  deriveFolderName,
  EXT_KIND_MAP,
} from '../scanner.ts';

describe('detectMaterialKind', () => {
  it('识别受支持的扩展名映射', () => {
    assert.equal(detectMaterialKind('a.mp4'), 'video');
    assert.equal(detectMaterialKind('b.mov'), 'video');
    assert.equal(detectMaterialKind('c.mp3'), 'audio');
    assert.equal(detectMaterialKind('d.txt'), 'text');
    assert.equal(detectMaterialKind('e.srt'), 'subtitle');
  });

  it('扩展名大小写不敏感', () => {
    assert.equal(detectMaterialKind('A.MP4'), 'video');
    assert.equal(detectMaterialKind('B.Srt'), 'subtitle');
  });

  it('不支持的扩展名或无法识别返回 undefined', () => {
    assert.equal(detectMaterialKind('x.exe'), undefined);
    assert.equal(detectMaterialKind('y.png'), undefined);
    assert.equal(detectMaterialKind('noext'), undefined);
    assert.equal(detectMaterialKind(''), undefined);
  });

  it('EXT_KIND_MAP 覆盖全部支持类型', () => {
    assert.deepEqual(EXT_KIND_MAP, {
      '.mp4': 'video',
      '.mov': 'video',
      '.mp3': 'audio',
      '.txt': 'text',
      '.srt': 'subtitle',
    });
  });
});

describe('deriveFolderName', () => {
  it('取路径末尾 basename(兼容 / 与 \\)', () => {
    assert.equal(deriveFolderName('/a/b/c'), 'c');
    assert.equal(deriveFolderName('C:\\x\\y\\z'), 'z');
  });

  it('路径以分隔符结尾时仍返回非空 basename', () => {
    assert.equal(deriveFolderName('/a/b/'), 'b');
  });

  it('根路径无 basename 时返回原路径', () => {
    const rootPosix = deriveFolderName('/');
    assert.ok(typeof rootPosix === 'string');
    assert.notEqual(rootPosix.trim(), '');
  });
});
