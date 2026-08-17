/**
 * 长文本分片器纯函数单测
 * 职责:验证 splitLongText 的多级切分回退(段落>句子>空格>硬切)、码点安全、offset 计算,
 *      以及 isWithinCharLimit 长度校验
 * 运行:npm run test 或 node --test --import tsx src/main/services/tts/__tests__/text-splitter.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitLongText, isWithinCharLimit } from '../text-splitter.ts';

describe('splitLongText', () => {
  it('空文本/空白返回空数组', () => {
    assert.deepEqual(splitLongText('', 10), []);
    assert.deepEqual(splitLongText('   \n  ', 10), []);
  });

  it('短文本不超过上限时返回单个分片', () => {
    const chunks = splitLongText('你好世界', 500);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, '你好世界');
    assert.equal(chunks[0].offset, 0);
    assert.equal(chunks[0].index, 0);
  });

  it('在句子结束标点处切分,保留完整句子', () => {
    const chunks = splitLongText('第一句。第二句。', 4);
    // 4 字符内优先在句号后切:第一句。| 第二句。
    assert.deepEqual(chunks.map((c) => c.text), ['第一句。', '第二句。']);
  });

  it('超长无标点文本在空格处回退切分', () => {
    const chunks = splitLongText('aaa bbb ccc', 5);
    // 5 个字符内在空格后回退:aaa | bbb | ccc
    assert.deepEqual(chunks.map((c) => c.text), ['aaa', 'bbb', 'ccc']);
  });

  it('无任何分隔时按上限硬切', () => {
    const chunks = splitLongText('abcdefgh', 4);
    assert.deepEqual(chunks.map((c) => c.text), ['abcd', 'efgh']);
  });

  it('offset 为各分片在原文中的起始码点偏移', () => {
    const chunks = splitLongText('一二三四五六七八', 4);
    assert.deepEqual(chunks.map((c) => c.offset), [0, 4]);
    assert.deepEqual(chunks.map((c) => c.text), ['一二三四', '五六七八']);
  });

  it('4 字节 emoji 不被截断(基于码点安全切片)', () => {
    const text = '😀😀😀😀'; // 4 个 4 字节 emoji
    const chunks = splitLongText(text, 2);
    // 每个分片 2 个 emoji
    assert.deepEqual(chunks.map((c) => c.text), ['😀😀', '😀😀']);
  });
});

describe('isWithinCharLimit', () => {
  it('按码点统计长度(emoji 计为 1)', () => {
    assert.equal(isWithinCharLimit('abc'), true);
    assert.equal(isWithinCharLimit('😀😀', 2), true);
    assert.equal(isWithinCharLimit('😀😀', 1), false);
  });

  it('默认上限为 50000', () => {
    assert.equal(isWithinCharLimit('x'.repeat(50000)), true);
    assert.equal(isWithinCharLimit('x'.repeat(50001)), false);
  });
});
