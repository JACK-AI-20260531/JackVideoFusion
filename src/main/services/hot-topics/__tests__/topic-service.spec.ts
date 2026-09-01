/**
 * 选题建议容错解析单测(PRD-v1.7 FR-6)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuggestions } from '../topic-service';

describe('parseSuggestions', () => {
  it('解析合法 JSON 数组', () => {
    const raw = JSON.stringify([
      { title: '选题1', angle: '角度1', tags: ['#搞笑', '#日常'] },
      { title: '选题2', angle: '角度2', tags: [] },
    ]);
    const result = parseSuggestions(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, '选题1');
    assert.equal(result[0].angle, '角度1');
    assert.deepEqual(result[0].tags, ['#搞笑', '#日常']);
  });

  it('剥离 markdown 围栏后解析', () => {
    const raw = '```json\n[{"title":"T1","angle":"A1","tags":["#x"]}]\n```';
    const result = parseSuggestions(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'T1');
  });

  it('从混杂文本中截取数组', () => {
    const raw = '以下是建议:\n[{"title":"混合文本","angle":"","tags":[]}]\n以上';
    const result = parseSuggestions(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, '混合文本');
  });

  it('无 title 的条目跳过,标签过滤非法项并截断到 3 条', () => {
    const raw = JSON.stringify([
      { angle: '无标题' },
      { title: 'T', tags: ['#a', '', 42, '#b', '#c', '#d'] },
    ]);
    const result = parseSuggestions(raw);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].tags, ['#a', '#b', '#c']);
  });

  it('超过 5 条截断到 5 条;无法解析返回空数组', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, angle: '', tags: [] }));
    assert.equal(parseSuggestions(JSON.stringify(many)).length, 5);
    assert.deepEqual(parseSuggestions('完全不是 JSON'), []);
  });
});
