/**
 * 发布数据自动采集调度器单测(PRD-v1.7 FR-1)
 * 覆盖:到期判定(无历史/早期加密/成熟期/超期停止)与 runOnce 编排
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextCollectDueAt,
  pickDueVideoUrls,
  AnalyticsScheduler,
} from '../analytics-scheduler';
import type { CollectPlanOptions } from '../analytics-scheduler';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 紧凑策略便于测试 */
const PLAN: CollectPlanOptions = {
  recentWindowMs: 72 * HOUR,
  recentIntervalMs: 6 * HOUR,
  matureIntervalMs: 24 * HOUR,
  maxTrackMs: 30 * DAY,
};

describe('nextCollectDueAt', () => {
  it('无采集历史 → 立即到期(0)', () => {
    assert.equal(nextCollectDueAt({ videoUrl: 'u', history: [] }, 1000, PLAN), 0);
  });

  it('早期窗口(72h 内)按 6h 间隔调度', () => {
    const now = Date.now();
    const first = now - 10 * HOUR;
    const last = now - 7 * HOUR;
    const due = nextCollectDueAt(
      { videoUrl: 'u', history: [{ collectedAt: new Date(first).toISOString() }, { collectedAt: new Date(last).toISOString() }] },
      now,
      PLAN,
    );
    assert.equal(due, last + 6 * HOUR);
  });

  it('成熟期(超 72h)按 24h 间隔调度', () => {
    const now = Date.now();
    const first = now - 3 * DAY;
    const last = now - 1 * HOUR;
    const due = nextCollectDueAt(
      {
        videoUrl: 'u',
        history: [
          { collectedAt: new Date(first).toISOString() },
          { collectedAt: new Date(last).toISOString() },
        ],
      },
      now,
      PLAN,
    );
    assert.equal(due, last + 24 * HOUR);
  });

  it('超过最长追踪时长返回 null(不再调度)', () => {
    const first = Date.now() - 31 * DAY;
    assert.equal(
      nextCollectDueAt({ videoUrl: 'u', history: [{ collectedAt: new Date(first).toISOString() }] }, Date.now(), PLAN),
      null,
    );
  });

  it('采集时间非法视为立即到期', () => {
    assert.equal(nextCollectDueAt({ videoUrl: 'u', history: [{ collectedAt: 'bad' }] }, 1000, PLAN), 0);
  });
});

describe('pickDueVideoUrls', () => {
  it('仅返回到期条目', () => {
    const now = Date.now();
    const records = [
      { videoUrl: 'due-empty', history: [] },
      { videoUrl: 'not-due', history: [{ collectedAt: new Date(now - 1 * HOUR).toISOString() }] },
      { videoUrl: 'due-old', history: [{ collectedAt: new Date(now - 8 * HOUR).toISOString() }] },
      { videoUrl: 'stop', history: [{ collectedAt: new Date(now - 31 * DAY).toISOString() }] },
    ];
    const urls = pickDueVideoUrls(records, now, PLAN);
    assert.deepEqual(urls.sort(), ['due-empty', 'due-old']);
  });
});

describe('AnalyticsScheduler.runOnce', () => {
  it('采集到期条目并追加存储,失败条目隔离', async () => {
    const now = Date.now();
    const records = [
      {
        videoUrl: 'https://v/1',
        platform: 'douyin',
        history: [{ collectedAt: new Date(now - 8 * HOUR).toISOString() }],
      },
      {
        videoUrl: 'https://v/2',
        platform: 'douyin',
        history: [{ collectedAt: new Date(now - 1 * HOUR).toISOString() }],
      },
      {
        videoUrl: 'https://v/3',
        platform: 'bilibili',
        history: [{ collectedAt: new Date(now - 8 * HOUR).toISOString() }],
      },
    ];
    let calls = 0;
    const appended: { videoUrl: string; stats: unknown }[] = [];
    const scheduler = new AnalyticsScheduler({
      store: {
        list: () => records as never,
        appendStats: (videoUrl: string, stats: never) => {
          appended.push({ videoUrl, stats });
        },
      } as never,
      adapterFactory:
        (() =>
          ({
            fetchStats: async () => {
              calls++;
              if (calls === 2) throw new Error('boom');
              return { plays: 1, collectedAt: new Date().toISOString() };
            },
          }) as never) as never,
      checkIntervalMs: 1000,
    });
    const result = await scheduler.runOnce(now);
    // v1 到期采集成功;v2 未到期;v3 到期但适配器抛错
    assert.equal(result.collected, 1);
    assert.equal(result.failed, 1);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].videoUrl, 'https://v/1');
  });

  it('store.list 抛错不向外传播', async () => {
    const scheduler = new AnalyticsScheduler({
      store: {
        list: () => {
          throw new Error('boom');
        },
        appendStats: () => {},
      } as never,
      adapterFactory: (() => ({})) as never,
    });
    const result = await scheduler.runOnce(Date.now());
    assert.equal(result.collected, 0);
  });

  it('并发调用去重(运行中直接返回 0)', async () => {
    const now = Date.now();
    let resolveFirst: ((v: unknown) => void) | null = null;
    const scheduler = new AnalyticsScheduler({
      store: {
        list: () =>
          [
            {
              videoUrl: 'https://v/1',
              platform: 'douyin',
              history: [{ collectedAt: new Date(now - 8 * HOUR).toISOString() }],
            },
          ] as never,
        appendStats: () => {},
      } as never,
      adapterFactory:
        (() =>
          ({
            fetchStats: () =>
              new Promise((resolve) => {
                resolveFirst = resolve;
              }),
          }) as never) as never,
      checkIntervalMs: 1000,
    });
    const first = scheduler.runOnce(now);
    const second = await scheduler.runOnce(now);
    assert.deepEqual(second, { collected: 0, failed: 0 });
    resolveFirst?.({ collectedAt: new Date().toISOString() });
    const done = await first;
    assert.equal(done.collected, 1);
  });
});
