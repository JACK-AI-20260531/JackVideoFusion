/**
 * 发布数据自动采集调度器(PRD-v1.7 数据飞轮与全景矩阵 FR-1)
 *
 * 职责:
 *   - 纯函数 nextCollectDueAt:按"发布早期加密、成熟期降频"策略计算下次应采集时间
 *   - AnalyticsScheduler:按固定间隔扫描应采集的记录,复用平台适配器 fetchStats 采集
 *
 * 采集策略(默认):
 *   - 无采集历史 → 立即到期(发布后首次采集)
 *   - 首次采集后 72h 内:每 6h 一次(把握早期流量曲线)
 *   - 超过 72h:每 24h 一次
 *   - 追踪超过 30 天:停止采集(视频进入长尾)
 *   - 平台未实现 fetchStats:跳过,永不调度
 *
 * 设计要点:
 *   - 到期判定为纯函数,可单测;调度器只做"到期 → 采集 → 追加"编排
 *   - 采集失败静默跳过(记 warn 日志),不重试不阻断其余条目
 */
import { logger } from '../../utils/logger';
import type { AnalyticsStore } from './analytics-store';
import type { PublishPlatform, PlatformAdapter } from './types';

/** 采集策略选项 */
export interface CollectPlanOptions {
  /** 早期加密窗口(毫秒,默认 72h) */
  recentWindowMs: number;
  /** 早期采集间隔(毫秒,默认 6h) */
  recentIntervalMs: number;
  /** 成熟期采集间隔(毫秒,默认 24h) */
  matureIntervalMs: number;
  /** 最长追踪时长(毫秒,默认 30d,超过不再调度) */
  maxTrackMs: number;
}

/** 默认采集策略 */
export const DEFAULT_COLLECT_PLAN: CollectPlanOptions = {
  recentWindowMs: 72 * 60 * 60 * 1000,
  recentIntervalMs: 6 * 60 * 60 * 1000,
  matureIntervalMs: 24 * 60 * 60 * 1000,
  maxTrackMs: 30 * 24 * 60 * 60 * 1000,
};

/** 采集调度的最小记录结构 */
export interface CollectibleRecord {
  /** 视频链接 */
  videoUrl: string;
  /** 历次采集时间线(最新在末尾,空表示未采集过) */
  history: { collectedAt: string }[];
}

/** 可调度采集的完整记录(含平台,runOnce 编排用) */
export interface SchedulableRecord extends CollectibleRecord {
  /** 所属平台 */
  platform: PublishPlatform;
}

/**
 * 计算下次应采集的时间戳
 * @param record 分析记录
 * @param now 当前时间戳(毫秒)
 * @param options 采集策略(默认 DEFAULT_COLLECT_PLAN)
 * @returns 下次到期时间戳(毫秒);不再调度返回 null;立即到期返回 0
 */
export function nextCollectDueAt(
  record: CollectibleRecord,
  now: number,
  options: CollectPlanOptions = DEFAULT_COLLECT_PLAN,
): number | null {
  if (!record || record.history.length === 0) return 0;
  const first = Date.parse(record.history[0]?.collectedAt ?? '');
  if (!Number.isFinite(first)) return 0;
  const age = now - first;
  if (age > options.maxTrackMs) return null;
  const last = Date.parse(record.history[record.history.length - 1]?.collectedAt ?? '');
  const lastAt = Number.isFinite(last) ? last : first;
  const interval =
    age < options.recentWindowMs ? options.recentIntervalMs : options.matureIntervalMs;
  return lastAt + interval;
}

/**
 * 挑选当前到期应采集的视频链接列表
 * @param records 分析记录列表
 * @param now 当前时间戳(毫秒)
 * @param options 采集策略
 * @returns 到期的 videoUrl 列表
 */
export function pickDueVideoUrls(
  records: CollectibleRecord[],
  now: number,
  options: CollectPlanOptions = DEFAULT_COLLECT_PLAN,
): string[] {
  return records
    .filter((r) => {
      const dueAt = nextCollectDueAt(r, now, options);
      return dueAt !== null && now >= dueAt;
    })
    .map((r) => r.videoUrl);
}

/** AnalyticsScheduler 依赖注入 */
export interface AnalyticsSchedulerDeps {
  /** 分析存储(默认全局 analyticsStore) */
  store: Pick<AnalyticsStore, 'list' | 'appendStats'>;
  /** 适配器工厂(默认全局 adapterFactory) */
  adapterFactory: (platform: PublishPlatform) => PlatformAdapter;
  /** 检查间隔毫秒(默认 30 分钟) */
  checkIntervalMs?: number;
}

/**
 * 发布数据自动采集调度器
 * start 后每 checkIntervalMs 检查一次到期条目并采集;单条失败不影响其余
 */
export class AnalyticsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly store: AnalyticsSchedulerDeps['store'];
  private readonly adapterFactory: AnalyticsSchedulerDeps['adapterFactory'];
  private readonly checkIntervalMs: number;
  private running = false;

  constructor(deps: AnalyticsSchedulerDeps) {
    this.store = deps.store;
    this.adapterFactory = deps.adapterFactory;
    this.checkIntervalMs = deps.checkIntervalMs ?? 30 * 60 * 1000;
  }

  /** 启动定时检查(幂等) */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.checkIntervalMs);
    // 启动后 1 分钟先跑一轮,尽快补齐错过的采集
    setTimeout(() => {
      void this.runOnce();
    }, 60 * 1000).unref?.();
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 执行一轮到期采集
   * @returns { collected, failed } 成功/失败条数
   */
  async runOnce(now: number = Date.now()): Promise<{ collected: number; failed: number }> {
    if (this.running) return { collected: 0, failed: 0 };
    this.running = true;
    let collected = 0;
    let failed = 0;
    try {
      let records: SchedulableRecord[];
      try {
        records = this.store.list() as SchedulableRecord[];
      } catch (err) {
        logger.warn(
          `[analytics-scheduler] 读取分析记录失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { collected: 0, failed: 0 };
      }
      const dueUrls = new Set(pickDueVideoUrls(records, now, DEFAULT_COLLECT_PLAN));
      for (const record of records) {
        if (!dueUrls.has(record.videoUrl)) continue;
        try {
          const adapter = this.adapterFactory(record.platform);
          if (typeof adapter.fetchStats !== 'function') continue;
          const stats = await adapter.fetchStats(record.videoUrl);
          this.store.appendStats(record.videoUrl, stats);
          collected++;
        } catch (err) {
          failed++;
          logger.warn(
            `[analytics-scheduler] 采集 ${record.videoUrl} 失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (collected > 0) {
        logger.info(`[analytics-scheduler] 本轮自动采集 ${collected} 条(失败 ${failed})`);
      }
      return { collected, failed };
    } finally {
      this.running = false;
    }
  }
}
