/**
 * 爆款评分历史存储(PRD-v1.7 数据飞轮与全景矩阵 FR-3)
 *
 * 职责:
 *   - 每次批量评分后持久化"切片路径 → 五维子分"映射,userData/ai-slice/score-history.json
 *   - 供权重校准(joinCalibrationSamples)与发布数据精确匹配切片路径
 *
 * 设计约定:
 *   - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron(照抄 AnalyticsStore 模式)
 *   - 条目数上限 ENTRY_LIMIT,切片总数上限 CLIP_LIMIT(裁剪最旧)
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { ViralitySubScores } from './types';

/** 单条评分历史条目 */
export interface ScoreHistoryEntry {
  /** 评分时间(ISO) */
  scoredAt: string;
  /** 参与评分的切片(路径 + 五维子分) */
  clips: { outputPath: string; sub: ViralitySubScores; score: number }[];
}

/** 条目数上限(超出裁剪最旧) */
export const SCORE_HISTORY_ENTRY_LIMIT = 100;

/** ScoreHistoryStore 依赖注入(照抄 AnalyticsStore 模式) */
export interface ScoreHistoryStoreDeps {
  load?: () => ScoreHistoryEntry[];
  persist?: (entries: ScoreHistoryEntry[]) => void;
}

/** 默认持久化文件路径(userData/ai-slice/score-history.json) */
function historyFile(): string {
  const dir = join(app.getPath('userData'), 'ai-slice');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'score-history.json');
}

/** 默认加载实现 */
function defaultLoad(): ScoreHistoryEntry[] {
  try {
    const fp = historyFile();
    if (!existsSync(fp)) return [];
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return Array.isArray(parsed) ? (parsed as ScoreHistoryEntry[]) : [];
  } catch (err) {
    logger.error(`[score-history] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(entries: ScoreHistoryEntry[]): void {
  try {
    const fp = historyFile();
    writeFileSync(fp, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[score-history] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 评分历史存储
 * 追加式写入,每次变更即落盘;load/persist 可注入
 */
export class ScoreHistoryStore {
  private entries: ScoreHistoryEntry[] = [];
  private readonly loadFn: () => ScoreHistoryEntry[];
  private readonly persistFn: (entries: ScoreHistoryEntry[]) => void;
  private loaded = false;

  constructor(deps: ScoreHistoryStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = this.loadFn();
    this.entries = Array.isArray(stored) ? stored : [];
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.entries);
  }

  /**
   * 追加一条评分历史(超限裁剪最旧)
   * @param entry 评分条目
   */
  add(entry: ScoreHistoryEntry): void {
    this.ensureLoaded();
    this.entries.push(entry);
    if (this.entries.length > SCORE_HISTORY_ENTRY_LIMIT) {
      this.entries = this.entries.slice(-SCORE_HISTORY_ENTRY_LIMIT);
    }
    this.flush();
  }

  /** 列出全部评分历史(按时间升序) */
  list(): ScoreHistoryEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  /** 清空历史(测试/手动维护用) */
  clear(): void {
    this.entries = [];
    this.flush();
  }
}

/** 评分历史存储单例 */
export const scoreHistoryStore = new ScoreHistoryStore();
