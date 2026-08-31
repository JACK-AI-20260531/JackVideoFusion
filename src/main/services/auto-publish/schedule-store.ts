/**
 * 定时发布持久化调度(PRD-爆款评分与智能分发 FR-5)
 *
 * 职责:
 *   - 定时任务条目的持久化存储(userData/auto-publish/schedule.json),重启不丢
 *   - 状态机:pending → firing → done/failed/cancelled(校验非法流转)
 *   - classifySchedule 纯函数:immediate(立即)/upcoming(未到点)/missed(错过)
 *
 * 设计约定:
 *   - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron
 *   - 本模块只维护"定时视角"的条目;任务执行态仍以 task-queue 为准
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';

/** 定时条目状态(PRD FR-5 状态机) */
export type ScheduleStatus = 'pending' | 'firing' | 'done' | 'failed' | 'cancelled';

/** 定时发布条目 */
export interface ScheduledEntry {
  /** 关联的发布任务 ID(publishQueue 任务 ID) */
  taskId: string;
  /** 目标平台 */
  platform: string;
  /** 视频标题 */
  title: string;
  /** 定时发布时间(ISO) */
  scheduledAt: string;
  /** 条目创建时间(ISO) */
  createdAt: string;
  /** 当前状态 */
  status: ScheduleStatus;
  /** 失败/错过原因(可选) */
  error?: string;
}

/** 定时分类:immediate=立即发布 / upcoming=未到点 / missed=已错过(应用未运行) */
export type ScheduleClass = 'immediate' | 'upcoming' | 'missed';

/**
 * 对定时发布时间做分类
 * @param scheduledAt 定时发布时间(ISO);为空/非法视为立即发布
 * @param now 当前时间戳(毫秒)
 * @returns immediate / upcoming / missed
 */
export function classifySchedule(scheduledAt: string | undefined, now: number): ScheduleClass {
  if (!scheduledAt || scheduledAt.trim().length === 0) return 'immediate';
  const target = new Date(scheduledAt).getTime();
  if (isNaN(target)) return 'immediate';
  if (target > now) return 'upcoming';
  return 'missed';
}

/** 合法的状态流转表 */
const TRANSITIONS: Record<ScheduleStatus, ScheduleStatus[]> = {
  pending: ['firing', 'failed', 'cancelled'],
  firing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/**
 * 校验状态流转是否合法
 * @param from 当前状态
 * @param to 目标状态
 */
export function canTransition(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** ScheduleStore 依赖注入(单测注入内存实现,绕开 electron) */
export interface ScheduleStoreDeps {
  /** 加载持久化条目(默认:读 userData/auto-publish/schedule.json) */
  load?: () => ScheduledEntry[];
  /** 持久化条目(默认:写 userData/auto-publish/schedule.json) */
  persist?: (entries: ScheduledEntry[]) => void;
}

/** 默认持久化文件路径(userData/auto-publish/schedule.json) */
function scheduleFile(): string {
  const dir = join(app.getPath('userData'), 'auto-publish');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'schedule.json');
}

/** 默认加载实现 */
function defaultLoad(): ScheduledEntry[] {
  try {
    const fp = scheduleFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as ScheduledEntry[];
  } catch (err) {
    logger.error(
      `[schedule-store] 加载失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(entries: ScheduledEntry[]): void {
  try {
    const fp = scheduleFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    logger.error(
      `[schedule-store] 持久化失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 定时发布条目存储
 * 内存 Map + 每次变更即落盘;load/persist 可注入
 */
export class ScheduleStore {
  /** 条目:taskId → entry */
  private entries = new Map<string, ScheduledEntry>();
  /** 注入的加载/持久化实现 */
  private readonly loadFn: () => ScheduledEntry[];
  private readonly persistFn: (entries: ScheduledEntry[]) => void;
  /** 是否已加载过 */
  private loaded = false;

  constructor(deps: ScheduleStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化条目(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const entry of this.loadFn()) {
      this.entries.set(entry.taskId, entry);
    }
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.list());
  }

  /**
   * 新增或更新条目(同 taskId 覆盖)
   * @param entry 条目(status 缺省为 pending)
   */
  upsert(entry: ScheduledEntry): void {
    this.ensureLoaded();
    this.entries.set(entry.taskId, entry);
    this.flush();
  }

  /**
   * 状态流转(校验非法流转并告警)
   * @param taskId 条目 ID
   * @param status 目标状态
   * @param error 失败/错过原因(可选)
   * @returns 是否流转成功(条目不存在或流转非法返回 false)
   */
  markStatus(taskId: string, status: ScheduleStatus, error?: string): boolean {
    this.ensureLoaded();
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    if (!canTransition(entry.status, status)) {
      logger.warn(`[schedule-store] 非法流转 ${entry.status} → ${status}(taskId=${taskId}),忽略`);
      return false;
    }
    entry.status = status;
    if (error !== undefined) entry.error = error;
    this.flush();
    return true;
  }

  /**
   * 查询条目
   * @param taskId 条目 ID
   */
  get(taskId: string): ScheduledEntry | null {
    this.ensureLoaded();
    return this.entries.get(taskId) ?? null;
  }

  /**
   * 列出全部条目(按定时时间升序)
   */
  list(): ScheduledEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  /**
   * 列出指定状态的条目
   * @param status 状态
   */
  listByStatus(status: ScheduleStatus): ScheduledEntry[] {
    return this.list().filter((e) => e.status === status);
  }

  /**
   * 移除条目
   * @param taskId 条目 ID
   */
  remove(taskId: string): void {
    this.ensureLoaded();
    this.entries.delete(taskId);
    this.flush();
  }
}

/** 定时发布条目存储单例 */
export const scheduleStore = new ScheduleStore();
