/**
 * 发布数据看板聚合单测(PRD-v1.7 FR-2)
 * 覆盖:汇总合计 / 互动率 / 24h 增量 / 发布窗口计数 / 排序
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, DAY_MS } from '../dashboard';
import type { AnalyticsRecord } from './analytics-store';

const NOW = Date.parse('2026-09-01T12:00:00Z');

/** 构造分析记录 */
function record(partial: Partial<AnalyticsRecord>): AnalyticsRecord {
  return {
    videoUrl: 'https://v/default',
    taskId: 't1',
    platform: 'douyin',
    title: '默认标题',
    history: [],
    ...partial,
  };
}

describe('buildDashboard', () => {
  it('空记录 → 全零摘要', () => {
    const d = buildDashboard([], NOW);
    assert.equal(d.totalVideos, 0);
    assert.equal(d.totalPlays, 0);
    assert.equal(d.published7d, 0);
    assert.equal(d.published30d, 0);
    assert.equal(d.items.length, 0);
  });

  it('无采集历史的记录仅计入 totalVideos', () => {
    const d = buildDashboard([record({ videoUrl: 'u1' })], NOW);
    assert.equal(d.totalVideos, 1);
    assert.equal(d.totalPlays, 0);
    assert.equal(d.items[0].plays, undefined);
    assert.equal(d.items[0].sampleCount, 0);
  });

  it('汇总合计与互动率计算', () => {
    const d = buildDashboard(
      [
        record({
          videoUrl: 'u1',
          history: [
            { plays: 100, likes: 10, comments: 5, collectedAt: '2026-08-20T00:00:00Z' },
            { plays: 1000, likes: 100, comments: 50, collectedAt: '2026-08-31T00:00:00Z' },
          ],
        }),
        record({
          videoUrl: 'u2',
          history: [{ plays: 500, likes: 25, comments: 25, collectedAt: '2026-08-30T00:00:00Z' }],
        }),
      ],
      NOW,
    );
    assert.equal(d.totalVideos, 2);
    assert.equal(d.totalPlays, 1500);
    assert.equal(d.totalLikes, 125);
    assert.equal(d.totalComments, 75);
    // u1 互动率 = (100+50)/1000 = 0.15
    assert.ok(Math.abs((d.items[0].engagementRate ?? 0) - 0.15) < 1e-9);
  });

  it('24h 播放增量取最新基线', () => {
    const d = buildDashboard(
      [
        record({
          videoUrl: 'u1',
          history: [
            { plays: 100, collectedAt: new Date(NOW - 30 * 3600 * 1000).toISOString() },
            { plays: 120, collectedAt: new Date(NOW - 25 * 3600 * 1000).toISOString() },
            { plays: 180, collectedAt: new Date(NOW - 2 * 3600 * 1000).toISOString() },
          ],
        }),
      ],
      NOW,
    );
    // 基线 = 最新一条 ≤ now-24h 的采集(120)
    assert.equal(d.items[0].playsDelta24h, 60);
  });

  it('发布窗口计数(7 天/30 天按首次采集)', () => {
    const d = buildDashboard(
      [
        record({
          videoUrl: 'a',
          history: [{ collectedAt: new Date(NOW - 3 * DAY_MS).toISOString() }],
        }),
        record({
          videoUrl: 'b',
          history: [{ collectedAt: new Date(NOW - 10 * DAY_MS).toISOString() }],
        }),
        record({
          videoUrl: 'c',
          history: [{ collectedAt: new Date(NOW - 40 * DAY_MS).toISOString() }],
        }),
      ],
      NOW,
    );
    assert.equal(d.published7d, 1);
    assert.equal(d.published30d, 2);
  });

  it('按最新播放数降序排列', () => {
    const d = buildDashboard(
      [
        record({
          videoUrl: 'low',
          history: [{ plays: 10, collectedAt: '2026-08-30T00:00:00Z' }],
        }),
        record({
          videoUrl: 'high',
          history: [{ plays: 999, collectedAt: '2026-08-30T00:00:00Z' }],
        }),
        record({ videoUrl: 'none' }),
      ],
      NOW,
    );
    assert.deepEqual(
      d.items.map((i) => i.videoUrl),
      ['high', 'low', 'none'],
    );
  });
});
