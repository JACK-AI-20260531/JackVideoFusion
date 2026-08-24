/**
 * 素材处理服务单测
 * 职责:验证 listVideoFiles 列出目录下视频文件的过滤行为与异常容错
 * 说明:extractSubtitle 依赖真实 ffmpeg 进程,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/material-process/__tests__/index.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listVideoFiles } from '../index.ts';

let tempDir = '';

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jvf-matproc-'));
  // 视频文件
  writeFileSync(join(tempDir, 'a.mp4'), 'x');
  writeFileSync(join(tempDir, 'b.MOV'), 'x');
  // 非视频文件
  writeFileSync(join(tempDir, 'c.txt'), 'x');
  writeFileSync(join(tempDir, 'd.srt'), 'x');
  // 子目录(不应被列出)
  mkdirSync(join(tempDir, 'sub'));
  writeFileSync(join(tempDir, 'sub', 'e.mp4'), 'x');
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('listVideoFiles', () => {
  it('只返回目录下的视频文件(绝对路径)', () => {
    const files = listVideoFiles(tempDir);
    const names = files.map((f) => f.split(/[\\/]/).pop() ?? f).sort();
    assert.deepEqual(names, ['a.mp4', 'b.MOV']);
    // 返回绝对路径
    assert.equal(files[0].startsWith(tempDir), true);
  });

  it('不递归子目录', () => {
    const files = listVideoFiles(tempDir).map((f) => f.split(/[\\/]/).pop() ?? f);
    assert.ok(!files.includes('e.mp4'), '子目录内的视频不应被列出');
  });

  it('空路径返回空数组', () => {
    assert.deepEqual(listVideoFiles(''), []);
  });

  it('目录不存在或不可读时返回空数组且不抛错', () => {
    assert.deepEqual(listVideoFiles(join(tempDir, 'no-such-dir')), []);
  });
});
