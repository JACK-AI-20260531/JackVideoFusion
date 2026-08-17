/**
 * CLIP 确定性嵌入纯函数单测
 * 职责:验证 deterministicEmbedding 的确定性/区分度/L2 归一化,以及 cosineSimilarity 数学正确性
 *      不依赖 electron,可独立单元测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/embedding.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicEmbedding,
  cosineSimilarity,
} from '../embedding.ts';
import { CLIP_EMBEDDING_DIM } from '../types.ts';

describe('deterministicEmbedding', () => {
  it('相同输入产生完全相同向量(确定性)', () => {
    const a = deterministicEmbedding('精彩画面');
    const b = deterministicEmbedding('精彩画面');
    assert.equal(a.length, CLIP_EMBEDDING_DIM);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it('不同输入产生不同向量(有区分度)', () => {
    const a = deterministicEmbedding('动作');
    const b = deterministicEmbedding('安静');
    const same = Array.from(a).every((v, i) => v === b[i]);
    assert.equal(same, false);
  });

  it('输出为 L2 归一化向量(模长为 1)', () => {
    const v = deterministicEmbedding('abc');
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6);
  });

  it('空输入不产生零向量', () => {
    const v = deterministicEmbedding('');
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
    assert.ok(norm > 0.99);
  });
});

describe('cosineSimilarity', () => {
  it('相同向量相似度为 1', () => {
    const v = deterministicEmbedding('test');
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  });

  it('不匹配向量或长度不同返回 0 或低相似度', () => {
    const a = deterministicEmbedding('a');
    assert.equal(cosineSimilarity(a, new Float32Array(0)), 0);
  });

  it('结果在 [-1, 1] 区间', () => {
    const a = deterministicEmbedding('x');
    const b = deterministicEmbedding('y');
    const sim = cosineSimilarity(a, b);
    assert.ok(sim >= -1 && sim <= 1);
  });

  it('相似文本比不相似文本有更高相似度', () => {
    const base = deterministicEmbedding('精彩画面');
    const same = deterministicEmbedding('精彩画面');
    const other = deterministicEmbedding('完全无关的文字描述');
    const simSame = cosineSimilarity(base, same);
    const simOther = cosineSimilarity(base, other);
    assert.ok(simSame > simOther);
  });
});
