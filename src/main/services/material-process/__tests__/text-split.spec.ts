/**
 * 文本分割纯函数单测
 * 职责:验证 splitText 的段落拆分/标点拆句/贪心打包/标点处理分支
 * 运行:node --test --experimental-strip-types src/main/services/material-process/__tests__/text-split.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from '../text-split.ts';

describe('splitText', () => {
  it('空文本或非法 charLimit 返回空数组', () => {
    assert.deepEqual(splitText('', 10, { keepPunct: true, autoParagraph: false }), []);
    assert.deepEqual(splitText('abc', 0, { keepPunct: true, autoParagraph: false }), []);
    assert.deepEqual(splitText('abc', -5, { keepPunct: true, autoParagraph: false }), []);
  });

  it('短文本不足 charLimit 时返回单条', () => {
    const out = splitText('你好世界', 20, { keepPunct: true, autoParagraph: false });
    assert.deepEqual(out, ['你好世界']);
  });

  it('keepPunct=false 时剔除全部中英文标点', () => {
    const out = splitText('你好，世界！测试。', 20, { keepPunct: false, autoParagraph: false });
    assert.deepEqual(out, ['你好世界测试']);
  });

  it('keepPunct=true 时保留标点并支持按句末标点拆句', () => {
    const out = splitText('第一句。第二句！第三句', 4, { keepPunct: true, autoParagraph: false });
    // 每句≤4(含标点),分别成段
    assert.deepEqual(out, ['第一句。', '第二句！', '第三句']);
  });

  it('贪心打包:多条短句组合进不超过 charLimit 的片段', () => {
    const out = splitText('一二。三四五六。七八九十。', 10, {
      keepPunct: true,
      autoParagraph: false,
    });
    // 句子:"一二。"(3)、"三四五六。"(5)、"七八九十。"(6)
    assert.deepEqual(out, ['一二。三四五六。', '七八九十。']);
  });

  it('单句超长时按 charLimit 硬切分', () => {
    const out = splitText('一二三四五六七八九十', 4, { keepPunct: true, autoParagraph: false });
    assert.deepEqual(out, ['一二三四', '五六七八', '九十']);
  });

  it('autoParagraph 模式以换行为句子边界,随后统一打包', () => {
    // 段落作为句子来源,但打包仍跨段落合并(总长≤charLimit 则合并)
    const out = splitText('段落一\n\n段落二\n段落三', 10, {
      keepPunct: true,
      autoParagraph: true,
    });
    assert.deepEqual(out, ['段落一段落二段落三']);

    // 若合并会超长,则按 charLimit 拆成多段
    const out2 = splitText('段落一\n\n段落二\n段落三', 5, {
      keepPunct: true,
      autoParagraph: true,
    });
    assert.deepEqual(out2, ['段落一', '段落二', '段落三']);
  });
});
