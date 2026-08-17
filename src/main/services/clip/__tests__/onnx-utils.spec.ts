/**
 * CLIP ONNX 预处理纯函数单测
 * 职责:验证 simpleTokenize 分词、normalizeImagePixels 图像归一化、normalizeL2、
 *      toFloat32Array 类型转换
 *      不依赖 electron/onnx,可独立单元测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/onnx-utils.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simpleTokenize, normalizeImagePixels, normalizeL2, toFloat32Array,
  TEXT_CONTEXT_LENGTH, IMAGE_SIZE, CLIP_BOS_TOKEN, CLIP_EOS_TOKEN,
} from '../onnx-utils.ts';

describe('simpleTokenize', () => {
  it('首尾为 BOS/EOS,长度恒为上下文长度', () => {
    const tokens = simpleTokenize('你好');
    assert.equal(tokens.length, TEXT_CONTEXT_LENGTH);
    assert.equal(tokens[0], CLIP_BOS_TOKEN);
    // EOS 位于 'BOS + 字符数' 位置(2 字符 → tokens[3])
    assert.equal(tokens[3], CLIP_EOS_TOKEN);
  });

  it('超长文本截断到 77 且仍以 EOS 结尾', () => {
    const tokens = simpleTokenize('x'.repeat(200));
    assert.equal(tokens.length, TEXT_CONTEXT_LENGTH);
    assert.equal(tokens[0], CLIP_BOS_TOKEN);
    assert.equal(tokens[TEXT_CONTEXT_LENGTH - 1], CLIP_EOS_TOKEN);
  });

  it('空文本也有合法 BOS/EOS 结构', () => {
    const tokens = simpleTokenize('');
    assert.equal(tokens[0], CLIP_BOS_TOKEN);
    assert.equal(tokens[1], CLIP_EOS_TOKEN);
  });

  it('字符 codePoint 映射到词表范围内', () => {
    const tokens = simpleTokenize('abc');
    for (let i = 1; i <= 3; i++) {
      assert.ok(tokens[i] >= 0 && tokens[i] < 49408);
    }
  });
});

describe('normalizeImagePixels', () => {
  it('输出长度与 CHW 布局一致(3*224*224)', () => {
    const px = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE * 3);
    const out = normalizeImagePixels(px);
    assert.equal(out.length, 3 * IMAGE_SIZE * IMAGE_SIZE);
  });

  it('全黑像素按 CLIP 均值/标准差归一化(非零)', () => {
    const px = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE * 3); // 全 0
    const out = normalizeImagePixels(px);
    const idx = 0; // R 通道第一像素,(0/255 - mean)/std
    assert.ok(Math.abs(out[idx] - (0 - 0.48145466) / 0.26862954) < 1e-6);
  });

  it('全白像素归一化到偏正值', () => {
    const px = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE * 3).fill(255);
    const out = normalizeImagePixels(px);
    const idx = 0;
    assert.ok(Math.abs(out[idx] - (1 - 0.48145466) / 0.26862954) < 1e-6);
  });
});

describe('normalizeL2', () => {
  it('归一化后模长为 1(非零向量)', () => {
    const v = new Float32Array([3, 4]);
    const out = normalizeL2(v);
    const norm = Math.sqrt(out[0] * out[0] + out[1] * out[1]);
    assert.ok(Math.abs(norm - 1) < 1e-6);
  });

  it('零向量归一化后保持不变', () => {
    const v = new Float32Array([0, 0]);
    assert.deepEqual(Array.from(normalizeL2(v)), [0, 0]);
  });
});

describe('toFloat32Array', () => {
  it('Float32Array 原样返回', () => {
    const arr = new Float32Array([1, 2]);
    assert.equal(toFloat32Array(arr), arr);
  });

  it('其他数组类型转换为 Float32Array', () => {
    assert.deepEqual(Array.from(toFloat32Array([1, 2, 3])), [1, 2, 3]);
    assert.deepEqual(Array.from(toFloat32Array(new Int32Array([5, 6]))), [5, 6]);
  });
});
