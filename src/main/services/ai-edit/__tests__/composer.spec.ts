/**
 * AI 剪辑服务纯逻辑单测
 * 职责:验证 composeVideo 模块的 joinParagraphs(段落拼接为完整文案)
 * 说明:纯函数;composeVideo 主流程依赖 ffmpeg/tts 进程,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-edit/__tests__/composer.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinParagraphs } from '../composer.ts';
import type { SceneMatch } from '../types.ts';

function para(text: string): SceneMatch {
  return {
    paragraph: text,
    keyword: text,
    videoPath: '/v/a.mp4',
  } as SceneMatch;
}

describe('joinParagraphs', () => {
  it('多个段落用中文句号拼接', () => {
    const s = joinParagraphs([para('第一段'), para('第二段'), para('第三段')]);
    assert.equal(s, '第一段。第二段。第三段');
  });

  it('单段落原样返回', () => {
    assert.equal(joinParagraphs([para('只有一段')]), '只有一段');
  });

  it('空匹配列表返回空串', () => {
    assert.equal(joinParagraphs([]), '');
  });

  it('包含空段落的匹配不会被过滤(按原顺序拼接)', () => {
    const s = joinParagraphs([para('a'), para(''), para('b')]);
    assert.equal(s, 'a。。b');
  });
});
