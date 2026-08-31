/**
 * 发布数据回收存储单测
 * 职责:验证 parseCount 中文数量解析、parseStatsFromTexts 页面文本构造、
 *      AnalyticsStore 绑定/追加/时间线上限/持久化(注入内存实现,绕开 electron)
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/analytics-store.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnalyticsStore,
  parseCount,
  parseStatsFromTexts,
  ANALYTICS_HISTORY_LIMIT,
} from '../analytics-store.ts';
import type { AnalyticsRecord } from '../analytics-store.ts';

describe('parseCount', () => {
  it('解析中文万/亿单位', () => {
    assert.equal(parseCount('12.3万'), 123000);
    assert.equal(parseCount('1.2亿'), 120000000);
    assert.equal(parseCount('456'), 456);
  });

  it('容忍千分位与空白', () => {
    assert.equal(parseCount('1,234'), 1234);
    assert.equal(parseCount(' 12万 '), 120000);
  });

  it('空/非法输入返回 null', () => {
    assert.equal(parseCount(null), null);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount('暂无'), null);
    assert.equal(parseCount('12.3.4'), null);
  });
});

describe('parseStatsFromTexts', () => {
  it('全部命中:构造完整采集项', () => {
    const stats = parseStatsFromTexts(
      { plays: '12.3万', likes: '456', comments: '78' },
      '2026-09-01T00:00:00.000Z',
    );
    assert.equal(stats.plays, 123000);
    assert.equal(stats.likes, 456);
    assert.equal(stats.comments, 78);
    assert.equal(stats.collectedAt, '2026-09-01T00:00:00.000Z');
  });

  it('部分失败:对应字段缺省(允许部分缺失)', () => {
    const stats = parseStatsFromTexts({ plays: null, likes: '12' }, '2026-09-01T00:00:00.000Z');
    assert.equal(stats.plays, undefined);
    assert.equal(stats.likes, 12);
    assert.equal(stats.comments, undefined);
  });
});

describe('AnalyticsStore', () => {
  /** 构造注入内存实现的存储 */
  function makeStore() {
    const persisted: AnalyticsRecord[] = [];
    const store = new AnalyticsStore({
      load: () => [],
      persist: (records) => {
        persisted.length = 0;
        persisted.push(...records);
      },
    });
    return { store, persisted };
  }

  it('bind 创建记录并可查询,重复绑定只补齐字段不覆盖历史', () => {
    const { store } = makeStore();
    store.bind({ taskId: 't1', platform: 'douyin', title: '标题', videoUrl: 'https://v/1' });
    assert.equal(store.get('https://v/1')?.taskId, 't1');

    store.appendStats('https://v/1', { plays: 100, collectedAt: '2026-09-01T00:00:00.000Z' });
    store.bind({ taskId: 't1', platform: 'douyin', title: '标题2', videoUrl: 'https://v/1' });
    assert.equal(store.get('https://v/1')?.title, '标题2');
    assert.equal(store.get('https://v/1')?.history.length, 1);
  });

  it('appendStats 追加时间线且超限裁剪最旧', () => {
    const { store } = makeStore();
    store.bind({ taskId: 't1', platform: 'douyin', title: 't', videoUrl: 'https://v/1' });
    for (let i = 0; i < ANALYTICS_HISTORY_LIMIT + 5; i++) {
      store.appendStats('https://v/1', { plays: i, collectedAt: `2026-09-0${(i % 9) + 1}T00:00:00.000Z` });
    }
    const record = store.get('https://v/1');
    assert.equal(record?.history.length, ANALYTICS_HISTORY_LIMIT);
    // 最旧的被裁剪,最后一条保留最新值
    assert.equal(record?.history[record.history.length - 1].plays, ANALYTICS_HISTORY_LIMIT + 4);
  });

  it('listByTask / latestStats / remove', () => {
    const { store } = makeStore();
    store.bind({ taskId: 't1', platform: 'douyin', title: 't', videoUrl: 'https://v/1' });
    store.bind({ taskId: 't2', platform: 'kuaishou', title: 't', videoUrl: 'https://v/2' });
    store.appendStats('https://v/1', { plays: 100, collectedAt: '2026-09-01T00:00:00.000Z' });
    assert.equal(store.listByTask('t1').length, 1);
    assert.equal(store.latestStats('https://v/1')?.plays, 100);
    assert.equal(store.latestStats('https://v/2'), null);
    store.remove('https://v/1');
    assert.equal(store.get('https://v/1'), null);
  });

  it('变更即持久化;新实例懒加载继承数据', () => {
    const persisted: AnalyticsRecord[] = [];
    const store = new AnalyticsStore({
      load: () => [],
      persist: (records) => {
        persisted.length = 0;
        persisted.push(...records);
      },
    });
    store.bind({ taskId: 't1', platform: 'douyin', title: 't', videoUrl: 'https://v/1' });
    assert.equal(persisted.length, 1);

    const reloaded = new AnalyticsStore({ load: () => persisted, persist: () => undefined });
    assert.equal(reloaded.listByTask('t1').length, 1);
  });
});
