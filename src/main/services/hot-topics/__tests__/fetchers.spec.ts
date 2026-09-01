/**
 * 热榜抓取与解析单测(PRD-v1.7 FR-6)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBaiduHot,
  parseWeiboHot,
  parseDouyinHot,
  dedupeTopics,
  fetchTopicSource,
} from '../fetchers';

describe('parseBaiduHot', () => {
  it('解析 data.cards[].content[].word', () => {
    const json = {
      data: {
        cards: [
          { content: [{ word: '话题A' }, { word: '话题B' }] },
          { content: [{ word: '话题C' }] },
        ],
      },
    };
    assert.deepEqual(parseBaiduHot(json), ['话题A', '话题B', '话题C']);
  });

  it('非法形状返回空数组', () => {
    assert.deepEqual(parseBaiduHot(null), []);
    assert.deepEqual(parseBaiduHot({}), []);
    assert.deepEqual(parseBaiduHot({ data: { cards: 'bad' } }), []);
  });
});

describe('parseWeiboHot', () => {
  it('解析 data.realtime[].word', () => {
    const json = { data: { realtime: [{ word: '微博热1' }, { word: '微博热2' }] } };
    assert.deepEqual(parseWeiboHot(json), ['微博热1', '微博热2']);
  });

  it('非法形状返回空数组', () => {
    assert.deepEqual(parseWeiboHot({ data: null }), []);
  });
});

describe('parseDouyinHot', () => {
  it('解析 data[].word', () => {
    const json = { data: [{ word: '抖音热1' }, { word: '抖音热2' }] };
    assert.deepEqual(parseDouyinHot(json), ['抖音热1', '抖音热2']);
  });
});

describe('dedupeTopics', () => {
  it('跨源去重(小写归一),保留首个原文', () => {
    const merged = dedupeTopics(['热点', '新闻'], ['新闻', '热点', 'Sports'], ['sports']);
    assert.deepEqual(merged, ['热点', '新闻', 'Sports']);
  });

  it('空列表安全', () => {
    assert.deepEqual(dedupeTopics(), []);
    assert.deepEqual(dedupeTopics([]), []);
  });
});

describe('fetchTopicSource', () => {
  it('成功:解析并返回 topics', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ data: [{ word: '话题1' }] }),
      }) as unknown as Response) as typeof fetch;
    const result = await fetchTopicSource('test', 'https://x', parseDouyinHot, fetchImpl);
    assert.equal(result.ok, true);
    assert.deepEqual(result.topics, ['话题1']);
  });

  it('失败:ok=false 且 topics 为空,不抛错', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    const result = await fetchTopicSource('test', 'https://x', parseDouyinHot, fetchImpl);
    assert.equal(result.ok, false);
    assert.deepEqual(result.topics, []);
  });
});
