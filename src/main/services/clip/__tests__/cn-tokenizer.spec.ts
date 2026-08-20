/**
 * CN-CLIP 中文 wordpiece 分词器单测
 * 职责:验证 createChineseTokenizer 的默认 token / 词表构建 / wordpiece 切分 /
 *      超长截断 / 未登录词回退 / 空白忽略等纯函数行为。
 * 说明:cn-tokenizer 不依赖 electron,词表内容由外部注入,可在纯 Node 环境直接测试。
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/cn-tokenizer.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChineseTokenizer,
  getCachedTokenizer,
  CN_TEXT_MAX_LEN,
  CN_UNK_ID,
} from '../cn-tokenizer.ts';

/** 构造一个迷你 CN-CLIP 词表(每行一个 token) */
function makeVocabContent(lines: string[]): string {
  return lines.join('\n');
}

/** 标准迷你词表:特殊 token + 若干汉字 + 英文子词 + [UNK] */
const SAMPLE_VOCAB = makeVocabContent([
  '[PAD]',
  '[CLS]',
  '[SEP]',
  '[UNK]',
  '你',
  '好',
  '世',
  '界',
  'hello',
  '##ness',
  'a',
  'b',
]);

describe('createChineseTokenizer', () => {
  it('构建词表并正确统计 vocabSize(去重)', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    assert.equal(t.vocabSize, 12);
    assert.equal(t.vocab.get('你'), 4);
    assert.equal(t.vocab.get('[UNK]'), 3);
  });

  it('忽略空行与空白行', () => {
    const t = createChineseTokenizer('a\n\nb\n   \nc');
    assert.equal(t.vocabSize, 3);
  });

  it('重复 token 仅保留首个 id', () => {
    const t = createChineseTokenizer('a\nb\na');
    assert.equal(t.vocabSize, 2);
    assert.equal(t.vocab.get('a'), 0);
    assert.equal(t.vocab.get('b'), 1);
  });

  it('输出恒为 CN_TEXT_MAX_LEN,BOS 在首位', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('你好');
    assert.equal(out.length, CN_TEXT_MAX_LEN);
    assert.equal(out[0], 0); // bos_token_id = 0
  });

  it('中文按单字切分为对应词表 token', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('你好');
    // '你' id=4 → out[1];'好' id=5 → out[2];eos id=2 → out[3]
    assert.equal(out[1], 4);
    assert.equal(out[2], 5);
    assert.equal(out[3], 2);
  });

  it('英文连续串作为单一 word 切分', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('hello');
    // 'hello' 整词命中 id=8 → out[1];eos → out[2]
    assert.equal(out[1], 8);
    assert.equal(out[2], 2);
  });

  it('空白被忽略,不影响 token 序列', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const a = t.encodeToTokens('你 好');
    const b = t.encodeToTokens('你好');
    assert.deepEqual(Array.from(a).slice(0, 6), Array.from(b).slice(0, 6));
  });

  it('未登录字回退到 [UNK] token id', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('哈你'); // 哈 不在词表
    // 哈 → CN_UNK_ID;你 → 4
    assert.equal(CN_UNK_ID, 100);
    assert.equal(out[1], 100);
    assert.equal(out[2], 4);
  });

  it('wordpiece 最长优先匹配(含 ## 子词)', () => {
    // 制造一个需要用 ##ness 拼出的词:none 不在词表,但 'ne' 不存在……
    // 用 'bhello' 不命中,改用精确场景:输入 'helloness' 无整词,
    // 期望切分为 hello + ##ness
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('helloness');
    // 首词 hello id=8;其余 ##ness id=9
    assert.equal(out[1], 8);
    assert.equal(out[2], 9);
    assert.equal(out[3], 2);
  });

  it('超长文本截断且仍以 EOS 结尾', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const long = '你好'.repeat(CN_TEXT_MAX_LEN);
    const out = t.encodeToTokens(long);
    assert.equal(out.length, CN_TEXT_MAX_LEN);
    // EOS 固定落在 CN_TEXT_MAX_LEN-1 处
    assert.equal(out[CN_TEXT_MAX_LEN - 1], 2);
    // 倒数第二位置仍有有效 token,未被 padding 覆盖(说明截断而非溢出)
    assert.notEqual(out[CN_TEXT_MAX_LEN - 2], 0);
  });

  it('空字符串也有合法 BOS/EOS 结构', () => {
    const t = createChineseTokenizer(SAMPLE_VOCAB);
    const out = t.encodeToTokens('');
    assert.equal(out[0], 0);
    assert.equal(out[1], 2);
  });
});

describe('getCachedTokenizer', () => {
  it('相同词表内容返回同一实例(缓存生效)', () => {
    const a = getCachedTokenizer(SAMPLE_VOCAB);
    const b = getCachedTokenizer(SAMPLE_VOCAB + '\n');
    assert.equal(a, b);
  });
});
