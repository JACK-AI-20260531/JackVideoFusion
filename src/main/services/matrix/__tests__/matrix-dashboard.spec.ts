/**
 * 矩阵分组聚合单测(PRD-v2.1 FR-6)
 * 运行:node --test --import tsx src/main/services/matrix/__tests__/matrix-dashboard.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByGroup } from '../matrix-dashboard';
import type { AnalyticsRecord } from '../../auto-publish/analytics-store';
import type { MatrixGroup } from '../types';

/** 构造一条分析记录(单点采集历史,采集于 daysAgo 天前) */
function mkRecord(
  platform: string,
  title: string,
  plays: number,
  likes: number,
  comments: number,
  daysAgo: number,
): AnalyticsRecord {
  return {
    videoUrl: `https://v/${platform}-${title}-${daysAgo}`,
    taskId: `t-${platform}-${title}-${daysAgo}`,
    platform: platform as never,
    title,
    history: [
      { plays, likes, comments, collectedAt: new Date(Date.now() - daysAgo * 86400000).toISOString() },
    ],
  };
}

const GROUPS: MatrixGroup[] = [
  { id: 'g1', name: '剧情号', platforms: ['douyin', 'kuaishou'], createdAt: 't', updatedAt: 't' },
  { id: 'g2', name: '知识号', platforms: ['bilibili'], createdAt: 't', updatedAt: 't' },
];

describe('aggregateByGroup', () => {
  test('按分组聚合播放/互动/发布数,平台交集正确', () => {
    const records: AnalyticsRecord[] = [
      mkRecord('douyin', '剧情1', 1000, 50, 30, 1),
      mkRecord('kuaishou', '剧情2', 200, 10, 5, 20),
      mkRecord('bilibili', '知识1', 500, 30, 20, 2),
    ];
    const rows = aggregateByGroup(records, GROUPS, 30);
    const g1 = rows.find((r) => r.groupId === 'g1');
    assert.equal(g1?.totalPlays, 1200);
    assert.equal(g1?.totalEngagement, 95);
    assert.equal(g1?.published, 2);
    // 分组平均互动率 = (80/1000 + 15/200) / 2 = 0.0775
    assert.ok(Math.abs((g1?.engagementRate ?? 0) - 0.0775) < 1e-9);
  });

  test('days 窗口过滤近 N 天外的记录(不计数)', () => {
    const records: AnalyticsRecord[] = [mkRecord('douyin', '老视频', 100, 5, 5, 40)];
    const rows = aggregateByGroup(records, GROUPS, 7);
    const g1 = rows.find((r) => r.groupId === 'g1');
    // 40 天前的记录:不计入 published,但最新采集值仍计入总量(与 buildDashboard 口径一致)
    assert.equal(g1?.published, 0);
    assert.equal(g1?.totalPlays, 100);
  });

  test('无分组覆盖的平台记录不进任何分组', () => {
    const records: AnalyticsRecord[] = [mkRecord('xiaohongshu', 'x', 50, 5, 5, 1)];
    const rows = aggregateByGroup(records, GROUPS, 30);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].totalPlays, 0);
  });
});
