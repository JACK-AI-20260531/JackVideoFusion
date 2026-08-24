/**
 * FFmpeg 二进制检测纯逻辑单测
 * 职责:验证 parseWhichOutput 对 which/where 命令输出的首行解析
 * 说明:纯函数;detectFfmpegBinaries 依赖真实子进程与 PATH,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/ffmpeg/__tests__/binary.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhichOutput } from '../binary.ts';

describe('parseWhichOutput', () => {
  it('取首行路径并去除首尾空白', () => {
    assert.equal(parseWhichOutput('C:\\ffmpeg\\bin\\ffmpeg.exe\r\nC:\\other\\x\r\n'), 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  });

  it('LF 与 CRLF 均能处理', () => {
    assert.equal(parseWhichOutput('/usr/bin/ffmpeg\n/usr/local/bin/ffmpeg'), '/usr/bin/ffmpeg');
    assert.equal(parseWhichOutput('/usr/bin/ffmpeg\r\n/usr/local/bin/ffmpeg'), '/usr/bin/ffmpeg');
  });

  it('空字符串返回 null', () => {
    assert.equal(parseWhichOutput(''), null);
  });

  it('首行为空但后续有路径时返回 null(取首行且为空)', () => {
    assert.equal(parseWhichOutput('\n/usr/bin/ffmpeg'), null);
  });
});
