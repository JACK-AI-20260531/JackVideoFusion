/**
 * 矩阵分组聚合(PRD-v2.1 FR-6)
 * 职责:把发布分析记录按「矩阵分组」聚合为近 N 天的播放/互动/发布数
 * 设计要点:
 *  - 纯函数,不依赖 electron,可 node:test 单测
 *  - 记录的最新采集值 = 当前值(与 buildDashboard 口径一致)
 *  - 分组平均互动率 = Σ单条互动率 / 有效条数(播放>0)
 */
import type { AnalyticsRecord } from '../auto-publish/analytics-store';
import type { MatrixGroup } from './types';

/** 单分组聚合行 */
export interface GroupAggregate {
  groupId: string;
  name: string;
  /** 分组内各记录最新播放之和 */
  totalPlays: number;
  /** 分组内各记录最新点赞+评论之和 */
  totalEngagement: number;
  /** 近 N 天内首次采集的记录数(发布口径) */
  published: number;
  /** 分组平均互动率 = Σ单条互动率 / 有效条数(播放>0);无有效条目为 undefined */
  engagementRate?: number;
}

/**
 * 按矩阵分组聚合发布记录
 * @param records 分析记录
 * @param groups 矩阵分组
 * @param days 时间窗口(天)
 * @param now 当前时间戳(毫秒)
 * @returns 每分组一行(顺序与入参 groups 一致)
 */
export function aggregateByGroup(
  records: AnalyticsRecord[],
  groups: MatrixGroup[],
  days: number,
  now: number = Date.now(),
): GroupAggregate[] {
  const cutoff = now - days * 86400000;
  return groups.map((g) => {
    let totalPlays = 0;
    let totalEngagement = 0;
    let published = 0;
    let rateSum = 0;
    let rateCount = 0;
    for (const r of records) {
      if (!g.platforms.includes(r.platform)) continue;
      const history = r.history ?? [];
      const latest = history.length > 0 ? history[history.length - 1] : undefined;
      const firstAt = history.length > 0 ? Date.parse(history[0].collectedAt) : NaN;
      if (Number.isFinite(firstAt) && firstAt >= cutoff) published++;
      if (latest) {
        totalPlays += latest.plays ?? 0;
        totalEngagement += (latest.likes ?? 0) + (latest.comments ?? 0);
        if ((latest.plays ?? 0) > 0) {
          rateSum += ((latest.likes ?? 0) + (latest.comments ?? 0)) / (latest.plays as number);
          rateCount++;
        }
      }
    }
    return {
      groupId: g.id,
      name: g.name,
      totalPlays,
      totalEngagement,
      published,
      engagementRate: rateCount > 0 ? rateSum / rateCount : undefined,
    };
  });
}
