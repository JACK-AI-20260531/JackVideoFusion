/**
 * 语义匹配纯函数单测
 * 职责:覆盖 buildSemanticQuery(关键词拼接)与 scoreWithSemantic(双模态加权打分)
 * 运行:node --test --import tsx src/main/services/film-dub-clone/__tests__/semantic-matching.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticQuery, scoreWithSemantic } from '../semantic-matching.ts';

describe('buildSemanticQuery', () => {
  it('把关键词拼成空格分隔的查询文本', () => {
    assert.equal(buildSemanticQuery(['城市夜景', '高楼', '灯光']), '城市夜景 高楼 灯光');
  });

  it('过滤空串与空白关键词', () => {
    assert.equal(buildSemanticQuery(['城市', '', '  ', '夜景']), '城市 夜景');
  });

  it('空数组返回空串', () => {
    assert.equal(buildSemanticQuery([]), '');
  });

  it('非法输入(非数组)返回空串', () => {
    assert.equal(buildSemanticQuery(null as unknown as string[]), '');
    assert.equal(buildSemanticQuery(undefined as unknown as string[]), '');
  });
});

describe('scoreWithSemantic', () => {
  it('无语义分(NaN)→ 退化为纯视觉分', () => {
    assert.equal(scoreWithSemantic(0.8, NaN, 0.6), 0.8);
    assert.equal(scoreWithSemantic(0.5, NaN, 0.2), 0.5);
  });

  it('有权重:final = w * v + (1-w) * s', () => {
    // 0.6*0.8 + 0.4*0.6 = 0.48 + 0.24 = 0.72
    assert.ok(Math.abs(scoreWithSemantic(0.8, 0.6, 0.6) - 0.72) < 1e-6);
  });

  it('visualWeight=1 → 完全视觉', () => {
    assert.equal(scoreWithSemantic(0.7, 0.1, 1), 0.7);
  });

  it('visualWeight=0 → 完全语义', () => {
    assert.equal(scoreWithSemantic(0.1, 0.9, 0), 0.9);
  });

  it('分数越界被 clamp 到 [0,1]', () => {
    const v = scoreWithSemantic(-0.5, 2, 0.6);
    assert.ok(v >= 0 && v <= 1);
  });

  it('视觉分非法 → 返回 0', () => {
    assert.equal(scoreWithSemantic(NaN, 0.5, 0.6), 0);
  });
});
