/**
 * 发布数据回收存储(PRD-发布闭环与素材兜底 FR-1)
 *
 * 职责:
 *   - 视频数据采集项(播放/点赞/评论)的持久化,userData/auto-publish/analytics.json
 *   - 纯函数 parseCount(中文数量解析)/ parseStatsFromTexts(页面文本 → 采集项)
 *   - 每条视频保留历次采集时间线(最近 30 条)
 *
 * 设计约定:
 *   - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron(照抄 ScheduleStore 模式)
 *   - 采集为手动触发,本模块只负责存取,不做任何定时
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { PublishPlatform, VideoStats } from './types';

/** 单条视频的分析记录(按 videoUrl 去重) */
export interface AnalyticsRecord {
  /** 视频链接(平台发布后的分享/主页链接) */
  videoUrl: string;
  /** 关联的发布任务 ID */
  taskId: string;
  /** 所属平台 */
  platform: PublishPlatform;
  /** 关联的视频标题(便于面板展示) */
  title: string;
  /** 关联的发布视频文件路径(自动绑定时记录,用于权重校准精确匹配切片;PRD-v1.7 FR-3) */
  videoPath?: string;
  /** 历次采集时间线(最新在末尾,最多保留 30 条) */
  history: VideoStats[];
}

/** history 保留上限 */
export const ANALYTICS_HISTORY_LIMIT = 30;

/**
 * 解析中文数量文本为数字
 * "12.3万" → 12300;"1,234" → 1234;"456" → 456;非法 → null
 * @param text 原始文本(可空)
 * @returns 数量;无法解析返回 null
 */
export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/[,,\s]/g, '');
  if (cleaned.length === 0) return null;
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([万亿]?)$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (match[2] === '万') return Math.round(value * 10000);
  if (match[2] === '亿') return Math.round(value * 100000000);
  return Math.round(value);
}

/**
 * 从页面原始文本构造采集项
 * 各平台选择器取到的文本经 parseCount 解析,全部失败时对应字段缺省
 * @param texts 页面文本(可空字段)
 * @param collectedAt 采集时间(ISO)
 * @returns 采集项
 */
export function parseStatsFromTexts(
  texts: { plays?: string | null; likes?: string | null; comments?: string | null },
  collectedAt: string,
): VideoStats {
  const stats: VideoStats = { collectedAt };
  const plays = parseCount(texts.plays);
  const likes = parseCount(texts.likes);
  const comments = parseCount(texts.comments);
  if (plays !== null) stats.plays = plays;
  if (likes !== null) stats.likes = likes;
  if (comments !== null) stats.comments = comments;
  return stats;
}

/** ScheduleStore 同款依赖注入 */
export interface AnalyticsStoreDeps {
  /** 加载持久化记录(默认:读 userData/auto-publish/analytics.json) */
  load?: () => AnalyticsRecord[];
  /** 持久化记录(默认:写 userData/auto-publish/analytics.json) */
  persist?: (records: AnalyticsRecord[]) => void;
}

/** 默认持久化文件路径(userData/auto-publish/analytics.json) */
function analyticsFile(): string {
  const dir = join(app.getPath('userData'), 'auto-publish');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'analytics.json');
}

/** 默认加载实现 */
function defaultLoad(): AnalyticsRecord[] {
  try {
    const fp = analyticsFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as AnalyticsRecord[];
  } catch (err) {
    logger.error(`[analytics] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(records: AnalyticsRecord[]): void {
  try {
    const fp = analyticsFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(records, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[analytics] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 发布数据分析存储
 * 内存 Map + 每次变更即落盘;load/persist 可注入
 */
export class AnalyticsStore {
  /** 记录:videoUrl → record */
  private records = new Map<string, AnalyticsRecord>();
  private readonly loadFn: () => AnalyticsRecord[];
  private readonly persistFn: (records: AnalyticsRecord[]) => void;
  private loaded = false;

  constructor(deps: AnalyticsStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化记录(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const record of this.loadFn()) {
      this.records.set(record.videoUrl, record);
    }
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.list());
  }

  /**
   * 绑定视频链接(创建或更新记录;已有记录仅补齐 taskId/title/videoPath)
   * @param record 绑定信息
   */
  bind(record: Omit<AnalyticsRecord, 'history'>): AnalyticsRecord {
    this.ensureLoaded();
    const existing = this.records.get(record.videoUrl);
    if (existing) {
      existing.taskId = record.taskId;
      existing.title = record.title;
      existing.platform = record.platform;
      if (record.videoPath) existing.videoPath = record.videoPath;
      this.flush();
      return existing;
    }
    const created: AnalyticsRecord = { ...record, history: [] };
    this.records.set(record.videoUrl, created);
    this.flush();
    return created;
  }

  /**
   * 追加一次采集(时间线超限则裁剪最旧)
   * @param videoUrl 视频链接
   * @param stats 采集项
   */
  appendStats(videoUrl: string, stats: VideoStats): void {
    this.ensureLoaded();
    const record = this.records.get(videoUrl);
    if (!record) return;
    record.history.push(stats);
    if (record.history.length > ANALYTICS_HISTORY_LIMIT) {
      record.history = record.history.slice(-ANALYTICS_HISTORY_LIMIT);
    }
    this.flush();
  }

  /**
   * 查询记录
   * @param videoUrl 视频链接
   */
  get(videoUrl: string): AnalyticsRecord | null {
    this.ensureLoaded();
    return this.records.get(videoUrl) ?? null;
  }

  /**
   * 按任务 ID 查询记录(多平台发布同任务时返回全部)
   * @param taskId 任务 ID
   */
  listByTask(taskId: string): AnalyticsRecord[] {
    return this.list().filter((r) => r.taskId === taskId);
  }

  /**
   * 列出全部记录(按最近采集时间降序,无采集按插入序)
   */
  list(): AnalyticsRecord[] {
    this.ensureLoaded();
    return [...this.records.values()];
  }

  /**
   * 取最近一次采集项
   * @param videoUrl 视频链接
   */
  latestStats(videoUrl: string): VideoStats | null {
    const record = this.get(videoUrl);
    if (!record || record.history.length === 0) return null;
    return record.history[record.history.length - 1];
  }

  /**
   * 移除记录
   * @param videoUrl 视频链接
   */
  remove(videoUrl: string): void {
    this.ensureLoaded();
    this.records.delete(videoUrl);
    this.flush();
  }
}

/** 发布数据分析存储单例 */
export const analyticsStore = new AnalyticsStore();
