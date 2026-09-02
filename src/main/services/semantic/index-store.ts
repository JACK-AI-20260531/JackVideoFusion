/**
 * 素材语义索引存储(PRD-v2.1 FR-4)
 * 职责:materialId → 向量/标签 持久化(userData/semantic-index.json),变更即落盘
 * 设计要点:
 *  - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron
 *  - 结构照 schedule-store:内存 Map + 懒加载 + 每次变更即写盘
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { IndexedMaterial } from './types';

/** 依赖注入(单测注入内存实现) */
export interface SemanticIndexStoreDeps {
  /** 加载持久化索引(默认:读 userData/semantic/semantic-index.json) */
  load?: () => IndexedMaterial[];
  /** 持久化索引(默认:写 userData/semantic/semantic-index.json) */
  persist?: (list: IndexedMaterial[]) => void;
}

/** 默认持久化文件路径(userData/semantic/semantic-index.json) */
function storeFile(): string {
  const dir = join(app.getPath('userData'), 'semantic');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'semantic-index.json');
}

/** 默认加载实现 */
function defaultLoad(): IndexedMaterial[] {
  try {
    const fp = storeFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as IndexedMaterial[];
  } catch (err) {
    logger.error(`[semantic-index] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(list: IndexedMaterial[]): void {
  try {
    const fp = storeFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[semantic-index] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 语义索引存储(key=materialId,变更即落盘) */
export class SemanticIndexStore {
  private items = new Map<string, IndexedMaterial>();
  private readonly loadFn: () => IndexedMaterial[];
  private readonly persistFn: (list: IndexedMaterial[]) => void;
  private loaded = false;

  constructor(deps: SemanticIndexStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化数据(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const e of this.loadFn()) this.items.set(e.materialId, e);
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.list());
  }

  /** 写入/覆盖索引 */
  set(entry: IndexedMaterial): void {
    this.ensureLoaded();
    this.items.set(entry.materialId, entry);
    this.flush();
  }

  /** 查询索引 */
  get(materialId: string): IndexedMaterial | null {
    this.ensureLoaded();
    return this.items.get(materialId) ?? null;
  }

  /** 是否已索引 */
  has(materialId: string): boolean {
    this.ensureLoaded();
    return this.items.has(materialId);
  }

  /** 移除索引(素材删除时同步) */
  remove(materialId: string): void {
    this.ensureLoaded();
    if (this.items.delete(materialId)) this.flush();
  }

  /**
   * 批量条件清理(文件夹删除/重扫联动,PRD-v2.1 FR-4)
   * @param pred 条件(返回 true 的条目被移除)
   * @returns 移除条数;至少一次变更后落盘一次
   */
  removeWhere(pred: (entry: IndexedMaterial) => boolean): number {
    this.ensureLoaded();
    let removed = 0;
    for (const [key, entry] of [...this.items.entries()]) {
      if (pred(entry)) {
        this.items.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.flush();
    return removed;
  }

  /** 全量列表 */
  list(): IndexedMaterial[] {
    this.ensureLoaded();
    return [...this.items.values()];
  }

  /** 索引条数 */
  size(): number {
    this.ensureLoaded();
    return this.items.size;
  }
}

/** 全局单例 */
export const semanticIndexStore = new SemanticIndexStore();
