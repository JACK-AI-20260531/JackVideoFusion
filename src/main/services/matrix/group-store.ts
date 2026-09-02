/**
 * 矩阵分组存储(PRD-v2.1 FR-6)
 * 职责:平台分组矩阵的持久化,userData/auto-publish/matrix-groups.json,变更即落盘
 * 设计要点:
 *  - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron
 *  - 结构照 schedule-store:内存 Map + 懒加载 + 同名覆盖 id 稳定
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { MatrixGroup } from './types';

/** 分组名最大长度 */
export const GROUP_NAME_MAX_LEN = 30;

/** 合法平台集合(与 auto-publish adapters 一致) */
const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'shipinhao', 'spzx'];

/**
 * 校验分组(名称 + 平台集合)
 * @returns 错误信息;合法返回 null
 */
export function validateGroup(name: string, platforms: string[]): string | null {
  const nameErr = validateGroupName(name);
  if (nameErr) return nameErr;
  if (!Array.isArray(platforms) || platforms.length === 0) return '至少勾选一个平台';
  for (const p of platforms) {
    if (!PLATFORMS.includes(p)) return `平台非法: ${p}`;
  }
  return null;
}

/** 名称单独校验(表单即时反馈用) */
export function validateGroupName(name: string): string | null {
  if (!name || name.trim().length === 0) return '分组名称不能为空';
  if (name.length > GROUP_NAME_MAX_LEN) return `分组名称过长(≤${GROUP_NAME_MAX_LEN} 字符)`;
  return null;
}

/** 依赖注入(单测注入内存实现) */
export interface MatrixGroupStoreDeps {
  /** 加载持久化分组(默认:读 userData/auto-publish/matrix-groups.json) */
  load?: () => MatrixGroup[];
  /** 持久化分组(默认:写 userData/auto-publish/matrix-groups.json) */
  persist?: (list: MatrixGroup[]) => void;
}

/** 默认持久化文件路径 */
function storeFile(): string {
  const dir = join(app.getPath('userData'), 'auto-publish');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'matrix-groups.json');
}

/** 默认加载实现 */
function defaultLoad(): MatrixGroup[] {
  try {
    const fp = storeFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as MatrixGroup[];
  } catch (err) {
    logger.error(`[matrix-groups] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(list: MatrixGroup[]): void {
  try {
    const fp = storeFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[matrix-groups] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 矩阵分组存储(key=name,变更即落盘) */
export class MatrixGroupStore {
  private groupsMap = new Map<string, MatrixGroup>();
  private readonly loadFn: () => MatrixGroup[];
  private readonly persistFn: (list: MatrixGroup[]) => void;
  private loaded = false;

  constructor(deps: MatrixGroupStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化数据(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const g of this.loadFn()) this.groupsMap.set(g.name, g);
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.list());
  }

  /** 保存分组(同名覆盖,id 稳定) */
  save(name: string, platforms: string[]): MatrixGroup {
    const err = validateGroup(name, platforms);
    if (err) throw new Error(`matrix-groups:save 参数无效:${err}`);
    this.ensureLoaded();
    const existing = this.groupsMap.get(name);
    const now = new Date().toISOString();
    const group: MatrixGroup = {
      id: existing?.id ?? `mg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      platforms: [...platforms],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.groupsMap.set(name, group);
    this.flush();
    return group;
  }

  /** 全量列表(按更新时间降序) */
  list(): MatrixGroup[] {
    this.ensureLoaded();
    return [...this.groupsMap.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 按名称删除,返回是否成功 */
  remove(name: string): boolean {
    this.ensureLoaded();
    const ok = this.groupsMap.delete(name);
    if (ok) this.flush();
    return ok;
  }
}

/** 全局单例 */
export const matrixGroupStore = new MatrixGroupStore();
