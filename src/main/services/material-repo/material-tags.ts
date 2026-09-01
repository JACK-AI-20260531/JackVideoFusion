/**
 * 素材标签与筛选(PRD-v1.7 数据飞轮与全景矩阵 FR-5)
 *
 * 职责:
 *   - 素材标签(手动打标)的持久化,userData/material-repo/tags.json
 *   - 纯函数筛选:按标签/使用次数过滤素材列表
 *
 * 设计约定:
 *   - 依赖注入 load/persist,单测绕开 electron
 *   - 标签按素材绝对路径为键,与使用计数/查重存储解耦
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';

/** 路径 → 标签列表 */
export type TagsRecord = Record<string, string[]>;

/** TagsStore 依赖注入 */
export interface TagsStoreDeps {
  load?: () => TagsRecord;
  persist?: (record: TagsRecord) => void;
}

/** 默认持久化文件路径(userData/material-repo/tags.json) */
function tagsFile(): string {
  const dir = join(app.getPath('userData'), 'material-repo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'tags.json');
}

/** 默认加载实现 */
function defaultLoad(): TagsRecord {
  try {
    const fp = tagsFile();
    if (!existsSync(fp)) return {};
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as TagsRecord) : {};
  } catch (err) {
    logger.error(`[material-tags] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** 默认持久化实现 */
function defaultPersist(record: TagsRecord): void {
  try {
    const fp = tagsFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[material-tags] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 素材标签存储
 */
export class TagsStore {
  private record: TagsRecord = {};
  private readonly loadFn: () => TagsRecord;
  private readonly persistFn: (record: TagsRecord) => void;
  private loaded = false;

  constructor(deps: TagsStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = this.loadFn();
    this.record = stored && typeof stored === 'object' ? stored : {};
    this.loaded = true;
  }

  private flush(): void {
    this.persistFn(this.record);
  }

  /**
   * 设置素材标签(覆盖式)
   * @param path 素材绝对路径
   * @param tags 标签列表(空数组清除标签)
   */
  setTags(path: string, tags: string[]): void {
    this.ensureLoaded();
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
    if (cleaned.length === 0) {
      if (this.record[path]) {
        delete this.record[path];
        this.flush();
      }
      return;
    }
    this.record[path] = cleaned;
    this.flush();
  }

  /** 查询素材标签 */
  getTags(path: string): string[] {
    this.ensureLoaded();
    return this.record[path] ?? [];
  }

  /** 全量标签记录(只读副本) */
  list(): TagsRecord {
    this.ensureLoaded();
    return { ...this.record };
  }
}

/** 筛选选项 */
export interface MaterialFilter {
  /** 须包含的标签(任一命中即通过) */
  tag?: string;
  /** 最小使用次数(仅统计已有记录者;0 = 不过滤) */
  minUsage?: number;
}

/**
 * 按标签/使用次数筛选素材(纯函数)
 * @param materials 候选素材(须含 path 字段,如 MaterialMeta)
 * @param usage 使用记录表(素材路径 → 使用信息)
 * @param tags 标签记录(素材路径 → 标签列表,TagsStore.list() 传入)
 * @param filter 筛选条件
 * @returns 通过筛选的素材子集(保持原顺序)
 */
export function filterMaterials<T extends { path: string }>(
  materials: T[],
  usage: Record<string, { count?: number }>,
  tags: TagsRecord,
  filter: MaterialFilter,
): T[] {
  const { tag, minUsage = 0 } = filter;
  return materials.filter((m) => {
    if (tag) {
      const mt = tags[m.path] ?? [];
      if (!mt.includes(tag)) return false;
    }
    if (minUsage > 0) {
      const count = usage[m.path]?.count ?? 0;
      if (count < minUsage) return false;
    }
    return true;
  });
}

/** 素材标签存储单例 */
export const tagsStore = new TagsStore();
