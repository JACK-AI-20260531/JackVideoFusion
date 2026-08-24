/**
 * FFmpeg 服务纯逻辑单测
 * 职责:验证 parseFps 帧率解析、escapeFilterPath 路径转义、
 *      buildOverlayPosition / buildDrawtextPosition 位置表达式
 * 说明:这些均为纯函数;该文件不执行真实 ffmpeg 进程
 * 运行:npm run test 或 node --test --import tsx src/main/services/ffmpeg/__tests__/index.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFps,
  escapeFilterPath,
  buildOverlayPosition,
  buildDrawtextPosition,
} from '../index.ts';

describe('parseFps', () => {
  it('解析分数形式帧率', () => {
    assert.equal(parseFps('30/1'), 30);
    assert.equal(parseFps('30000/1001'), 30000 / 1001);
    assert.equal(parseFps('25/1'), 25);
  });

  it('解析纯数字形式帧率', () => {
    assert.equal(parseFps('29.97'), 29.97);
    assert.equal(parseFps('60'), 60);
  });

  it('非法或空输入返回 undefined', () => {
    assert.equal(parseFps(undefined), undefined);
    assert.equal(parseFps(''), undefined);
    assert.equal(parseFps('abc'), undefined);
    // 分母为 0 时降级为整体 parseFloat("1/0")=1
    assert.equal(parseFps('1/0'), 1);
    assert.equal(parseFps('/'), undefined);
  });
});

describe('escapeFilterPath', () => {
  it('反斜杠转正斜杠(且驱动盘冒号被转义)', () => {
    assert.equal(escapeFilterPath('C:\\a\\b\\c.mp4'), 'C\\:/a/b/c.mp4');
  });

  it('路径内冒号被转义', () => {
    assert.equal(escapeFilterPath('C:/my:file/sub.srt'), 'C\\:/my\\:file/sub.srt');
  });

  it('同时处理反斜杠与冒号', () => {
    assert.equal(escapeFilterPath('C:\\dir\\f:1.srt'), 'C\\:/dir/f\\:1.srt');
  });
});

describe('buildOverlayPosition', () => {
  it('九个位置正确映射(含边距)', () => {
    assert.deepEqual(buildOverlayPosition('left-top', 10, 20), { x: '10', y: '20' });
    assert.deepEqual(buildOverlayPosition('left-center', 10, 20), { x: '10', y: '(H-h)/2' });
    assert.deepEqual(buildOverlayPosition('left-bottom', 10, 20), { x: '10', y: 'H-h-20' });
    assert.deepEqual(buildOverlayPosition('center-top', 10, 20), { x: '(W-w)/2', y: '20' });
    assert.deepEqual(buildOverlayPosition('center', 10, 20), { x: '(W-w)/2', y: '(H-h)/2' });
    assert.deepEqual(buildOverlayPosition('center-bottom', 10, 20), { x: '(W-w)/2', y: 'H-h-20' });
    assert.deepEqual(buildOverlayPosition('right-top', 10, 20), { x: 'W-w-10', y: '20' });
    assert.deepEqual(buildOverlayPosition('right-center', 10, 20), { x: 'W-w-10', y: '(H-h)/2' });
    assert.deepEqual(buildOverlayPosition('right-bottom', 10, 20), { x: 'W-w-10', y: 'H-h-20' });
  });

  it('未知位置默认回退到 right-bottom', () => {
    assert.deepEqual(buildOverlayPosition('bogus' as never, 5, 6), { x: 'W-w-5', y: 'H-h-6' });
  });
});

describe('buildDrawtextPosition', () => {
  it('九个位置正确映射(含边距)', () => {
    assert.deepEqual(buildDrawtextPosition('left-top', 10, 20), { x: '10', y: '20' });
    assert.deepEqual(buildDrawtextPosition('left-center', 10, 20), { x: '10', y: '(h-text_h)/2' });
    assert.deepEqual(buildDrawtextPosition('left-bottom', 10, 20), { x: '10', y: 'h-text_h-20' });
    assert.deepEqual(buildDrawtextPosition('center-top', 10, 20), { x: '(w-text_w)/2', y: '20' });
    assert.deepEqual(buildDrawtextPosition('center', 10, 20), { x: '(w-text_w)/2', y: '(h-text_h)/2' });
    assert.deepEqual(buildDrawtextPosition('center-bottom', 10, 20), { x: '(w-text_w)/2', y: 'h-text_h-20' });
    assert.deepEqual(buildDrawtextPosition('right-top', 10, 20), { x: 'w-text_w-10', y: '20' });
    assert.deepEqual(buildDrawtextPosition('right-center', 10, 20), { x: 'w-text_w-10', y: '(h-text_h)/2' });
    assert.deepEqual(buildDrawtextPosition('right-bottom', 10, 20), { x: 'w-text_w-10', y: 'h-text_h-20' });
  });

  it('未知位置默认回退到 right-bottom', () => {
    assert.deepEqual(buildDrawtextPosition('bogus' as never, 5, 6), { x: 'w-text_w-5', y: 'h-text_h-6' });
  });
});
