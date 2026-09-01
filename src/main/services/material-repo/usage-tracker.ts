/**
 * 素材使用计数与防撞车(PRD-v1.7 数据飞轮与全景矩阵 FR-5)
 *
 * 职责:
 *   - 素材(按绝对路径)使用次数与最近使用时间的持久化,userData/material-repo/usage.json
 *   - 防撞车:复用间隔窗口内(默认 7 天)再次使用的素材给出警告;支持"跳过最近已用素材"
 *
 * 设计约定:
 *   - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron(照抄 AnalyticsStore 模式)
 *   - record 为追加语义:同一路径多次出现于同批产出时只计 1 次
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';

/** 单个素材的使用信息 */
export interface UsageEntry {
  /** 累计使用次数 */
  count: number;
  /** 最近使用时间(ISO) */
  lastUsedAt: string;
}

/** 使用记录表(素材绝对路径 → 使用信息) */
export type UsageRecord = Record<string, UsageEntry>;

/** 默认防撞车间隔窗口:7 天(毫秒) */
export const REUSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** UsageTracker 依赖注入(照抄 AnalyticsStore 模式) */
export interface UsageTrackerDeps {
  load?: () => UsageRecord;
  persist?: (record: UsageRecord) => void;
}

/** 默认持久化文件路径(userData/material-repo/usage.json) */
function usageFile(): string {
  const dir = join(app.getPath('userData'), 'material-repo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'usage.json');
}

/** 默认加载实现 */
function defaultLoad(): UsageRecord {
  try {
    const fp = usageFile();
    if (!existsSync(fp)) return {};
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as UsageRecord) : {};
  } catch (err) {
    logger.error(`[usage-tracker] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** 默认持久化实现 */
function defaultPersist(record: UsageRecord): void {
  try {
    const fp = usageFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[usage-tracker] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 素材使用计数存储
 * 内存 Map + 每次变更即落盘;load/persist 可注入
 * 注意:字段名为 entries,避免与 record() 方法同名冲突(类字段会覆盖原型方法)
 */
export class UsageTracker {
  private entries: UsageRecord = {};
  private readonly loadFn: () => UsageRecord;
  private readonly persistFn: (record: UsageRecord) => void;
  private loaded = false;

  constructor(deps: UsageTrackerDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = this.loadFn();
    this.entries = stored && typeof stored === 'object' ? stored : {};
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.entries);
  }

  /**
   * 记录一批素材被使用(去重后计数 +1 并更新最近使用时间)
   * @param paths 素材绝对路径列表(同批重复路径只计一次)
   * @param usedAt 使用时间(默认当前)
   */
  record(paths: string[], usedAt: Date = new Date()): void {
    this.ensureLoaded();
    const iso = usedAt.toISOString();
    for (const p of new Set(paths)) {
      if (!p) continue;
      const prev = this.entries[p];
      this.entries[p] = {
        count: (prev?.count ?? 0) + 1,
        lastUsedAt: iso > (prev?.lastUsedAt ?? '') ? iso : (prev?.lastUsedAt ?? iso),
      };
    }
    this.flush();
  }

  /**
   * 查询单个素材使用信息
   * @param path 素材绝对路径
   */
  get(path: string): UsageEntry | null {
    this.ensureLoaded();
    return this.entries[path] ?? null;
  }

  /**
   * 判断素材是否在复用间隔窗口内被使用过
   * @param path 素材绝对路径
   * @param now 当前时间戳(毫秒)
   * @param windowMs 间隔窗口毫秒(默认 7 天)
   */
  isRecentlyUsed(
    path: string,
    now = Date.now(),
    windowMs = REUSE_WINDOW_MS,
  ): boolean {
    const entry = this.get(path);
    if (!entry) return false;
    const last = Date.parse(entry.lastUsedAt);
    return Number.isFinite(last) && now - last < windowMs;
  }

  /**
   * 全量使用记录(只读副本)
   */
  list(): UsageRecord {
    this.ensureLoaded();
    return { ...this.entries };
  }
}

/**
 * 防撞车过滤:从候选素材中剔除间隔窗口内已使用的素材
 * 纯函数,便于独立单测
 * @param candidates 候选素材路径
 * @param usage 使用记录表
 * @param now 当前时间戳(毫秒)
 * @param windowMs 间隔窗口毫秒(默认 7 天)
 * @returns { kept: 保留路径, warned: 近期已用路径 }
 */
export function filterRecentUsage(
  candidates: string[],
  usage: UsageRecord,
  now: number,
  windowMs = REUSE_WINDOW_MS,
): { kept: string[]; warned: string[] } {
  const kept: string[] = [];
  const warned: string[] = [];
  for (const p of candidates) {
    const last = usage[p] ? Date.parse(usage[p].lastUsedAt) : NaN;
    const recent = Number.isFinite(last) && now - last < windowMs;
    if (recent) warned.push(p);
    else kept.push(p);
  }
  return { kept, warned };
}

/** 素材使用计数存储单例 */
export const usageTracker = new UsageTracker();
