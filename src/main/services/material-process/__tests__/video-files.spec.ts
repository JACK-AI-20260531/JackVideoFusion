/**
 * 视频文件过滤纯函数单测
 * 职责:验证从目录文件名列表中过滤出常见视频扩展名
 * 运行:node --test --experimental-strip-types src/main/services/material-process/__tests__/video-files.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isVideoFile, filterVideoFiles } from '../video-files.ts';

describe('isVideoFile', () => {
  it('识别常见视频扩展名', () => {
    assert.equal(isVideoFile('a.mp4'), true);
    assert.equal(isVideoFile('b.mov'), true);
    assert.equal(isVideoFile('c.MKV'), true);
    assert.equal(isVideoFile('d.avi'), true);
  });

  it('忽略非视频文件', () => {
    assert.equal(isVideoFile('a.txt'), false);
    assert.equal(isVideoFile('b.srt'), false);
    assert.equal(isVideoFile('c.png'), false);
  });

  it('大小写不敏感', () => {
    assert.equal(isVideoFile('A.MP4'), true);
    assert.equal(isVideoFile('a.Mp4'), true);
  });
});

describe('filterVideoFiles', () => {
  it('只返回视频文件', () => {
    assert.deepEqual(
      filterVideoFiles(['1.mp4', '2.srt', '3.MOV', '4.txt']),
      ['1.mp4', '3.MOV'],
    );
  });

  it('空列表返回空数组', () => {
    assert.deepEqual(filterVideoFiles([]), []);
  });
});
