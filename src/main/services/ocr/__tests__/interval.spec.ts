/**
 * OCR 抽帧间隔解析单测
 * 职责:验证 resolveFrameInterval 对默认值/边界/上限自适应的处理(纯函数)
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/interval.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFrameInterval } from '../interval.ts';

describe('resolveFrameInterval', () => {
  it('时长无效(<=0)时返回默认间隔 1', () => {
    assert.equal(resolveFrameInterval(0, 1), 1);
    assert.equal(resolveFrameInterval(-5, 1), 1);
  });

  it('请求间隔无效(<=0)时使用默认 1', () => {
    assert.equal(resolveFrameInterval(100, 0), 1);
    assert.equal(resolveFrameInterval(100, undefined), 1);
  });

  it('默认 maxFrames(600):帧数未超限时保持请求间隔', () => {
    // 时长 600s、间隔 1s -> 600 帧,未超 600 -> 保持 1
    assert.equal(resolveFrameInterval(600, 1), 1);
    // 时长 1200s、间隔 5s -> 240 帧,未超 -> 保持 5
    assert.equal(resolveFrameInterval(1200, 5), 5);
  });

  it('默认 maxFrames(600):帧数超限时自动增大间隔', () => {
    // 时长 3600s、间隔 1s -> 3600 帧 > 600 -> 拉大间隔到 3600/600=6
    assert.ok(Math.abs(resolveFrameInterval(3600, 1) - 6) < 1e-6);
  });

  it('自定义 maxFrames 上限生效', () => {
    // 时长 1000s、间隔 1s、maxFrames=100 -> 1000 帧 > 100 -> 间隔 = 1000/100 = 10
    assert.ok(Math.abs(resolveFrameInterval(1000, 1, 100) - 10) < 1e-6);
    // 时长 500s、间隔 1s、maxFrames=1000 -> 500 帧未超 -> 保持 1
    assert.equal(resolveFrameInterval(500, 1, 1000), 1);
  });

  it('maxFrames 无效(<=0)时用默认 600', () => {
    assert.ok(Math.abs(resolveFrameInterval(1200, 1, 0) - 2) < 1e-6); // 1200 帧>600 -> 1200/600=2
    assert.equal(resolveFrameInterval(100, 1, -1), 1); // 100 帧<600 -> 保持 1
  });
});
