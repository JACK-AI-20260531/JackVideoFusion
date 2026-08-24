/**
 * OCR 字幕提取纯逻辑单测
 * 职责:验证 frameTimeSec(抽帧索引→视频时间点)
 * 说明:纯函数;extractSubtitleOcr 主流程依赖 ffmpeg/Tesseract 服务,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/index.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frameTimeSec } from '../index.ts';

describe('frameTimeSec', () => {
  it('第一帧(索引 0)对应第 1 个间隔处', () => {
    assert.equal(frameTimeSec(0, 5), 5);
  });

  it('第 n 帧对应 (n+1)*interval', () => {
    assert.equal(frameTimeSec(1, 5), 10);
    assert.equal(frameTimeSec(4, 2), 10);
  });

  it('间隔为 1 时即索引+1', () => {
    assert.equal(frameTimeSec(0, 1), 1);
    assert.equal(frameTimeSec(9, 1), 10);
  });
});
