/**
 * 发布数据看板聚合(PRD-v1.7 数据飞轮与全景矩阵 FR-2)
 *
 * 职责:把 AnalyticsStore 的原始记录聚合为看板数据(汇总卡片 + 单条漏斗)
 * 设计要点:
 *   - 纯函数,输入记录数组输出聚合摘要,渲染层零计算
 *   - 数据缺失项(未采集/字段缺省)显示为 undefined,由 UI 以 "—" 呈现,不伪造 0
 *   - 互动率 = (点赞 + 评论) / 播放,播放 ≤ 0 时不计算
 */
import type { AnalyticsRecord } from './analytics-store';
import type { PublishPlatform } from './types';

/** 看板单条视频条目 */
export interface DashboardItem {
  /** 视频链接 */
  videoUrl: string;
  /** 关联任务 ID */
  taskId: string;
  /** 标题 */
  title: string;
  /** 平台 */
  platform: PublishPlatform;
  /** 最新播放数(未采集为 undefined) */
  plays?: number;
  /** 最新点赞数 */
  likes?: number;
  /** 最新评论数 */
  comments?: number;
  /** 互动率 = (点赞+评论)/播放(0-1);播放缺失/≤0 为 undefined */
  engagementRate?: number;
  /** 24h 播放增量(历史不足 24h 为 undefined) */
  playsDelta24h?: number;
  /** 采集次数 */
  sampleCount: number;
  /** 首次采集时间(ISO;未采集为 undefined) */
  firstCollectedAt?: string;
  /** 最新采集时间(ISO;未采集为 undefined) */
  latestCollectedAt?: string;
}

/** 看板聚合摘要 */
export interface DashboardSummary {
  /** 绑定的视频总数(含未采集) */
  totalVideos: number;
  /** 最新播放总数(仅有采集历史的记录) */
  totalPlays: number;
  /** 最新点赞总数 */
  totalLikes: number;
  /** 最新评论总数 */
  totalComments: number;
  /** 近 7 天发布数(按首次采集时间) */
  published7d: number;
  /** 近 30 天发布数(按首次采集时间) */
  published30d: number;
  /** 单条明细(按最新播放数降序) */
  items: DashboardItem[];
}

/** 24h 毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 聚合发布数据看板
 * @param records 分析记录列表
 * @param now 当前时间戳(毫秒,默认 Date.now())
 * @returns 看板摘要(单条按最新播放降序,无播放的排后)
 */
export function buildDashboard(records: AnalyticsRecord[], now = Date.now()): DashboardSummary {
  const items: DashboardItem[] = [];
  let totalPlays = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let published7d = 0;
  let published30d = 0;

  for (const record of records) {
    const history = record.history ?? [];
    const latest = history.length > 0 ? history[history.length - 1] : undefined;
    const firstCollectedAt = history.length > 0 ? history[0].collectedAt : undefined;

    // 发布窗口计数(按首次采集时间近似发布时间)
    if (firstCollectedAt) {
      const first = Date.parse(firstCollectedAt);
      if (Number.isFinite(first)) {
        const age = now - first;
        if (age <= 7 * DAY_MS) published7d++;
        if (age <= 30 * DAY_MS) published30d++;
      }
    }

    // 24h 播放增量:取最新一条 ≤ now-24h 的采集项为基线
    let playsDelta24h: number | undefined;
    if (latest && typeof latest.plays === 'number') {
      const dayAgo = now - DAY_MS;
      let baseline: number | undefined;
      for (const stat of history) {
        const t = Date.parse(stat.collectedAt);
        if (Number.isFinite(t) && t <= dayAgo && typeof stat.plays === 'number') {
          baseline = stat.plays;
        }
      }
      playsDelta24h = baseline !== undefined ? latest.plays - baseline : undefined;
    }

    const engagementRate =
      latest && typeof latest.plays === 'number' && latest.plays > 0
        ? ((latest.likes ?? 0) + (latest.comments ?? 0)) / latest.plays
        : undefined;

    totalPlays += latest?.plays ?? 0;
    totalLikes += latest?.likes ?? 0;
    totalComments += latest?.comments ?? 0;

    items.push({
      videoUrl: record.videoUrl,
      taskId: record.taskId,
      title: record.title,
      platform: record.platform,
      plays: latest?.plays,
      likes: latest?.likes,
      comments: latest?.comments,
      engagementRate,
      playsDelta24h,
      sampleCount: history.length,
      firstCollectedAt,
      latestCollectedAt: latest?.collectedAt,
    });
  }

  items.sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1));

  return {
    totalVideos: items.length,
    totalPlays,
    totalLikes,
    totalComments,
    published7d,
    published30d,
    items,
  };
}
