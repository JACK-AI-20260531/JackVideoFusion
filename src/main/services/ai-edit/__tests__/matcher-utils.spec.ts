/**
 * AI 编辑(mixture)文案分段/抽帧时间/缓存键纯逻辑单测
 * 职责:验证 splitParagraphs 文案分段、listSampleTimes 抽帧时间轴、frameCacheKey 缓存键
 * 说明:这几个纯函数从 matcher.ts 导出(不依赖 electron/LLM/CLIP),可在纯 Node 测试。
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-edit/__tests__/matcher-utils.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitParagraphs, listSampleTimes, frameCacheKey } from '../matcher.ts';

describe('splitParagraphs', () => {
  it('空串返回空数组', () => {
    assert.deepEqual(splitParagraphs(''), []);
    assert.deepEqual(splitParagraphs(undefined as unknown as string), []);
  });

  it('按中文/英文句号、问号、感叹号、换行切分为段落', () => {
    const segs = splitParagraphs('第一句。第二句!第三句?第四句！第五句？\n第六句');
    assert.equal(segs.length, 6);
    assert.ok(segs.includes('第一句'));
    assert.ok(segs.includes('第六句'));
  });

  it('去除空白段落', () => {
    const segs = splitParagraphs('你好。\n\n。！  ');
    // '你好' 一段,其余空段被过滤
    assert.deepEqual(segs, ['你好']);
  });

  it('无分隔符时返回单段(trim 后)', () => {
    assert.deepEqual(splitParagraphs('  一段完整文案  '), ['一段完整文案']);
  });
});

describe('listSampleTimes', () => {
  it('时长无效(<=0)返回空数组', () => {
    assert.deepEqual(listSampleTimes(0), []);
    assert.deepEqual(listSampleTimes(-5), []);
    assert.deepEqual(listSampleTimes(undefined as unknown as number), []);
  });

  it('适中时长:从 0.5s 起每 5s 一帧', () => {
    assert.deepEqual(listSampleTimes(16), [0.5, 5.5, 10.5, 15.5]);
  });

  it('短视频(<5s)不足一帧间隔时,返回该帧(起点)而非中点', () => {
    assert.deepEqual(listSampleTimes(3), [0.5]);
  });

  it('极短视频(不足起点偏移)时取中点', () => {
    assert.deepEqual(listSampleTimes(0.2), [0.1]);
  });

  it('边界时长仍正确生成', () => {
    assert.deepEqual(listSampleTimes(10.5), [0.5, 5.5]);
  });
});

describe('frameCacheKey', () => {
  it('生成 path|time 格式键', () => {
    assert.equal(frameCacheKey('C:/a.mp4', 5), 'C:/a.mp4|5');
    assert.equal(frameCacheKey('/v/b.mov', 10.5), '/v/b.mov|10.5');
  });
});
