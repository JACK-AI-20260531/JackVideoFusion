/**
 * 流水线存储(PRD-v2.1 FR-2)
 * 职责:Pipeline 持久化(userData/pipelines/pipelines.json),按 id 索引,变更即落盘
 * 设计要点:
 *  - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron
 *  - 结构照 schedule-store:内存 Map + 懒加载 + 每次变更即写盘
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { Pipeline, PipelineRunState } from './types';

/** 依赖注入(单测注入内存实现,绕开 electron) */
export interface PipelineStoreDeps {
  /** 加载持久化管线(默认:读 userData/pipelines/pipelines.json) */
  load?: () => Pipeline[];
  /** 持久化管线(默认:写 userData/pipelines/pipelines.json) */
  persist?: (list: Pipeline[]) => void;
}

/** 默认持久化文件路径(userData/pipelines/pipelines.json) */
function storeFile(): string {
  const dir = join(app.getPath('userData'), 'pipelines');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'pipelines.json');
}

/** 默认加载实现 */
function defaultLoad(): Pipeline[] {
  try {
    const fp = storeFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as Pipeline[];
  } catch (err) {
    logger.error(`[pipeline-store] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(list: Pipeline[]): void {
  try {
    const fp = storeFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[pipeline-store] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 流水线存储(按 id 索引,变更即落盘) */
export class PipelineStore {
  private items = new Map<string, Pipeline>();
  private readonly loadFn: () => Pipeline[];
  private readonly persistFn: (list: Pipeline[]) => void;
  private loaded = false;

  constructor(deps: PipelineStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化数据(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const p of this.loadFn()) this.items.set(p.id, p);
    this.loaded = true;
  }

  /** 新增或更新(按 id 覆盖) */
  upsert(p: Pipeline): void {
    this.ensureLoaded();
    this.items.set(p.id, p);
    this.persistFn(this.list());
  }

  /** 查询管线 */
  get(id: string): Pipeline | null {
    this.ensureLoaded();
    return this.items.get(id) ?? null;
  }

  /** 全量列表(按更新时间降序) */
  list(): Pipeline[] {
    this.ensureLoaded();
    return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 删除管线,返回是否删除成功 */
  remove(id: string): boolean {
    this.ensureLoaded();
    const ok = this.items.delete(id);
    if (ok) this.persistFn(this.list());
    return ok;
  }

  /** 写入最近一次运行状态 */
  setRun(id: string, run: PipelineRunState): boolean {
    this.ensureLoaded();
    const p = this.items.get(id);
    if (!p) return false;
    p.lastRun = run;
    p.lastRunAt = run.startedAt;
    this.persistFn(this.list());
    return true;
  }
}

/** 全局单例 */
export const pipelineStore = new PipelineStore();
