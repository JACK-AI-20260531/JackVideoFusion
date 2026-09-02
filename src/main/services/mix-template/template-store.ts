/**
 * 混剪参数模板存储(PRD-v2.1 FR-1)
 * 职责:MixParams 命名快照的保存/加载/删除,落 userData/mix-templates/templates.json
 * 设计要点:
 *  - 依赖注入 load/persist(默认 electron fs 实现),单测绕开 electron
 *  - 同名覆盖(upsert),id 稳定;每次变更即落盘
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import type { MixParams } from '../video-mix/types';
import type { MixTemplate, MixTemplateMeta } from './types';

/** 模板名最大长度 */
export const TEMPLATE_NAME_MAX_LEN = 50;

/**
 * 校验模板输入
 * @returns 错误信息;合法返回 null
 */
export function validateTemplateInput(name: string, params: MixParams): string | null {
  if (!name || name.trim().length === 0) return '模板名称不能为空';
  if (name.length > TEMPLATE_NAME_MAX_LEN) return `模板名称过长(≤${TEMPLATE_NAME_MAX_LEN} 字符)`;
  if (!params || typeof params !== 'object') return 'params 缺失';
  if (params.mode !== 'random' && params.mode !== 'audio-match') return 'params.mode 非法';
  if (!Array.isArray(params.folderIds) || params.folderIds.length === 0) {
    return 'folderIds 不能为空';
  }
  return null;
}

/** 依赖注入(单测注入内存实现) */
export interface MixTemplateStoreDeps {
  /** 加载持久化模板(默认:读 userData/mix-templates/templates.json) */
  load?: () => MixTemplate[];
  /** 持久化模板(默认:写 userData/mix-templates/templates.json) */
  persist?: (templates: MixTemplate[]) => void;
}

/** 默认持久化文件路径(userData/mix-templates/templates.json) */
function storeFile(): string {
  const dir = join(app.getPath('userData'), 'mix-templates');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'templates.json');
}

/** 默认加载实现 */
function defaultLoad(): MixTemplate[] {
  try {
    const fp = storeFile();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, 'utf8')) as MixTemplate[];
  } catch (err) {
    logger.error(`[mix-template] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 默认持久化实现 */
function defaultPersist(templates: MixTemplate[]): void {
  try {
    const fp = storeFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(templates, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[mix-template] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 混剪参数模板存储(按 name 索引,内存 Map + 每次变更落盘) */
export class MixTemplateStore {
  private templates = new Map<string, MixTemplate>();
  private readonly loadFn: () => MixTemplate[];
  private readonly persistFn: (list: MixTemplate[]) => void;
  private loaded = false;

  constructor(deps: MixTemplateStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  /** 懒加载持久化数据(首次访问时) */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const t of this.loadFn()) this.templates.set(t.name, t);
    this.loaded = true;
  }

  /** 落盘 */
  private flush(): void {
    this.persistFn(this.listFull());
  }

  /** 保存模板(同名覆盖,id 稳定) */
  save(name: string, params: MixParams, description?: string): MixTemplate {
    const err = validateTemplateInput(name, params);
    if (err) throw new Error(`mix-template:save 参数无效:${err}`);
    this.ensureLoaded();
    const existing = this.templates.get(name);
    const now = new Date().toISOString();
    const tpl: MixTemplate = {
      id:
        existing?.id ??
        `mixtpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: description || undefined,
      params: JSON.parse(JSON.stringify(params)) as MixParams,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.templates.set(name, tpl);
    this.flush();
    return tpl;
  }

  /** 按名称取模板 */
  get(name: string): MixTemplate | null {
    this.ensureLoaded();
    return this.templates.get(name) ?? null;
  }

  /** 元数据列表(按更新时间降序,不含 params) */
  listMeta(): MixTemplateMeta[] {
    return this.listFull().map(({ params: _params, ...meta }) => meta);
  }

  /** 删除模板,返回是否删除成功 */
  remove(name: string): boolean {
    this.ensureLoaded();
    const ok = this.templates.delete(name);
    if (ok) this.flush();
    return ok;
  }

  /** 全量列表(按更新时间降序) */
  private listFull(): MixTemplate[] {
    this.ensureLoaded();
    return [...this.templates.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

/** 全局单例 */
export const mixTemplateStore = new MixTemplateStore();
