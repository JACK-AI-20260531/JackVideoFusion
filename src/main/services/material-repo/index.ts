/**
 * 素材仓库主模块
 * 职责:文件夹注册、素材元数据管理、单文件夹抽取与跨文件夹审计
 * 核心硬约束(PRD 差异化):pickFromFolder 仅作用于单个 folderId,
 *   任何跨文件夹抽取必须显式走 pickAcrossFolders 并写审计日志。
 * 设计要点:
 *   1. (folderId, fileId) 二元组为作用域单位,内部所有 Map 均以 folderId 一级索引
 *   2. 通过依赖注入(scanner/warn)实现可测试性,生产环境使用默认实现
 *   3. pickFromFolder 实现末尾强制断言:返回的每个 MaterialMeta.folderId === 入参 folderId
 */
import { randomUUID } from 'crypto';
import { resolve, sep } from 'path';
import { promises as fs } from 'fs';
import type { MaterialMeta } from '../../../shared/types';
import { scanDirectory, deriveFolderName } from './scanner';
import type { FolderMeta, PickOpts, WhitelistPolicy, AuditEntry } from './types';
import { createRng, shuffle } from './pick-utils';

/**
 * 容错加载 logger.warn
 * 生产环境(Electron 主进程):require 成功,使用 winston logger
 * 测试环境(纯 node):require 失败时 fallback 到 console.warn,保证模块可独立加载
 * 这样既保留生产日志能力,又使单测可在无 electron 环境运行
 */
const defaultWarn: (message: string) => void = (() => {
  try {
    // 动态 require 避免静态 import 在测试环境触发 electron 依赖
    const loggerModule = require('../../utils/logger') as {
      logger: { warn: (m: string) => void };
    };
    return (message: string) => loggerModule.logger.warn(message);
  } catch {
    return (message: string) => console.warn(message);
  }
})();

/**
 * 素材仓库对外接口契约
 */
export interface MaterialRepo {
  /** 注册文件夹(已存在路径则返回旧 meta,不重复注册) */
  registerFolder(path: string): Promise<FolderMeta>;
  /** 移除文件夹及其全部素材引用 */
  removeFolder(folderId: string): void;
  /** 扫描指定文件夹下素材,刷新元数据并返回最新列表 */
  scanFolder(folderId: string): Promise<MaterialMeta[]>;
  /** 列出已注册文件夹 */
  listFolders(): FolderMeta[];
  /** 列出指定文件夹下的全部素材 */
  listMaterials(folderId: string): MaterialMeta[];
  /** 单文件夹抽取(核心隔离 API,不接受 folderIds[]) */
  pickFromFolder(folderId: string, count: number, opts?: PickOpts): MaterialMeta[];
  /** 跨文件夹抽取(强制审计) */
  pickAcrossFolders(folderIds: string[], policy: WhitelistPolicy): MaterialMeta[];
}

/**
 * 依赖注入参数(用于测试与解耦)
 */
export interface MaterialRepoDeps {
  /** 自定义扫描器(默认使用 scanDirectory) */
  scanner?: (folderPath: string) => Promise<Omit<MaterialMeta, 'folderId'>[]>;
  /** 自定义审计/警告输出(默认使用 logger.warn) */
  warn?: (message: string) => void;
  /** 自定义 UUID 生成器(便于测试固定 ID) */
  uuid?: () => string;
  /** 自定义当前时间函数(便于测试固定时间) */
  now?: () => Date;
  /** 自定义目录存在性校验(默认使用 fs.stat;测试可注入 noop 绕过文件系统) */
  existsCheck?: (folderPath: string) => Promise<void>;
}

/**
 * 规范化文件夹路径(绝对路径 + 平台分隔符)
 * @param folderPath 输入路径
 */
function normalizePath(folderPath: string): string {
  const resolved = resolve(folderPath);
  // 统一末尾不带分隔符,便于去重比较
  return resolved.endsWith(sep) && resolved.length > 1
    ? resolved.slice(0, -1)
    : resolved;
}

/**
 * 工厂函数:构造一个独立的素材仓库实例
 * 同一进程内可构造多个互不干扰的实例(便于测试隔离)
 * @param deps 可选依赖注入
 */
export function createMaterialRepo(deps: MaterialRepoDeps = {}): MaterialRepo {
  const scannerFn = deps.scanner ?? scanDirectory;
  const warnFn = deps.warn ?? defaultWarn;
  const uuidFn = deps.uuid ?? (() => randomUUID());
  const nowFn = deps.now ?? (() => new Date());
  // 默认目录校验:fs.stat 判断存在且为目录;测试可注入 noop 绕过文件系统
  const existsCheckFn =
    deps.existsCheck ??
    (async (folderPath: string) => {
      const stat = await fs.stat(folderPath);
      if (!stat.isDirectory()) {
        throw new Error(`不是目录: ${folderPath}`);
      }
    });

  // 文件夹元信息:folderId -> FolderMeta
  const folders = new Map<string, FolderMeta>();
  // 文件夹下素材列表:folderId -> MaterialMeta[]
  const materialsByFolder = new Map<string, MaterialMeta[]>();
  // unique 模式下已用素材:folderId -> Set<materialId>
  const usedByFolder = new Map<string, Set<string>>();
  // 路径去重:normalizedPath -> folderId
  const pathIndex = new Map<string, string>();

  /**
   * 校验 folderId 存在,不存在则抛错
   * @param folderId 文件夹 ID
   */
  function assertFolderExists(folderId: string): FolderMeta {
    const folder = folders.get(folderId);
    if (!folder) {
      throw new Error(`[material-repo] folderId 不存在: ${folderId}`);
    }
    return folder;
  }

  /**
   * 注册文件夹
   * 已存在的路径直接返回旧 meta,保证幂等
   */
  async function registerFolder(folderPath: string): Promise<FolderMeta> {
    const normalized = normalizePath(folderPath);
    const existingId = pathIndex.get(normalized);
    if (existingId) {
      // 幂等:同路径只注册一次
      const existing = folders.get(existingId);
      if (existing) return existing;
    }

    // 验证路径存在且为目录(扫描器内部会吞掉读取错误,这里做前置校验给用户清晰反馈)
    // existsCheckFn 可被测试注入 noop 以绕过真实文件系统
    try {
      await existsCheckFn(normalized);
    } catch (err) {
      throw new Error(
        `[material-repo] 文件夹路径不可访问: ${normalized} - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const id = uuidFn();
    const meta: FolderMeta = {
      id,
      path: normalized,
      name: deriveFolderName(normalized),
      materialCount: 0,
      addedAt: nowFn().toISOString(),
    };
    folders.set(id, meta);
    materialsByFolder.set(id, []);
    usedByFolder.set(id, new Set());
    pathIndex.set(normalized, id);
    return meta;
  }

  /**
   * 移除文件夹及其全部素材引用
   */
  function removeFolder(folderId: string): void {
    const meta = folders.get(folderId);
    if (!meta) return; // 幂等:不存在则无操作
    folders.delete(folderId);
    materialsByFolder.delete(folderId);
    usedByFolder.delete(folderId);
    pathIndex.delete(meta.path);
  }

  /**
   * 扫描指定文件夹,刷新其素材列表与 materialCount
   */
  async function scanFolder(folderId: string): Promise<MaterialMeta[]> {
    const meta = assertFolderExists(folderId);
    const scanned = await scannerFn(meta.path);
    // 注入 folderId 构成完整 MaterialMeta
    const list: MaterialMeta[] = scanned.map((item) => ({ ...item, folderId }));
    materialsByFolder.set(folderId, list);
    // 同步更新 folder.materialCount
    meta.materialCount = list.length;
    return list;
  }

  /**
   * 列出已注册文件夹(按 addedAt 升序,保证顺序可复现)
   */
  function listFolders(): FolderMeta[] {
    return Array.from(folders.values()).sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );
  }

  /**
   * 列出指定文件夹下的全部素材
   */
  function listMaterials(folderId: string): MaterialMeta[] {
    assertFolderExists(folderId);
    return (materialsByFolder.get(folderId) ?? []).slice();
  }

  /**
   * 单文件夹抽取 - 核心隔离 API
   * 硬约束:仅作用于入参 folderId,绝不读取其他文件夹数据
   */
  function pickFromFolder(
    folderId: string,
    count: number,
    opts?: PickOpts,
  ): MaterialMeta[] {
    assertFolderExists(folderId);

    // 仅取本文件夹素材,显式不读取其他 folderId 数据(隔离硬约束)
    const all = materialsByFolder.get(folderId) ?? [];
    let pool: MaterialMeta[] = all.slice();

    // 类型过滤
    if (opts?.kind) {
      pool = pool.filter((m) => m.kind === opts.kind);
    }
    // 排除 ID
    const excludeSet = new Set(opts?.excludeIds ?? []);
    if (excludeSet.size > 0) {
      pool = pool.filter((m) => !excludeSet.has(m.id));
    }
    // unique 模式:排除已用素材
    if (opts?.unique) {
      const used = usedByFolder.get(folderId) ?? new Set<string>();
      if (used.size > 0) {
        pool = pool.filter((m) => !used.has(m.id));
      }
    }

    // 洗牌后取前 count 个
    const rng = createRng(opts?.seed);
    shuffle(pool, rng);
    const safeCount = Math.max(0, Math.floor(count));
    const picked = pool.slice(0, safeCount);

    // unique 模式:把本次选中的加入已用集合
    if (opts?.unique) {
      const used = usedByFolder.get(folderId) ?? new Set<string>();
      for (const m of picked) used.add(m.id);
      usedByFolder.set(folderId, used);
    }

    // 文件夹隔离硬断言:每个返回的 meta.folderId 必须等于入参 folderId
    // 这是一道防御性编程护栏,任何代码改动破坏隔离都会在此立即失败
    for (const m of picked) {
      if (m.folderId !== folderId) {
        throw new Error(
          `[material-repo][隔离违规] pickFromFolder(folderId=${folderId}) ` +
            `返回了 folderId=${m.folderId} 的素材,隔离被破坏`,
        );
      }
    }

    return picked;
  }

  /**
   * 跨文件夹抽取 - 强制审计
   * 任何跨文件夹调用必须显式提供 WhitelistPolicy(含 reason),否则抛错
   */
  function pickAcrossFolders(
    folderIds: string[],
    policy: WhitelistPolicy,
  ): MaterialMeta[] {
    if (!policy || typeof policy.reason !== 'string' || policy.reason.trim() === '') {
      throw new Error(
        '[material-repo] 跨文件夹调用必须提供 policy.reason(审计要求)',
      );
    }
    // 校验所有 folderId 存在
    for (const fid of folderIds) {
      assertFolderExists(fid);
    }

    const allowedKinds = policy.allowedKinds
      ? new Set(policy.allowedKinds)
      : null;
    const perLimit =
      typeof policy.perFolderLimit === 'number' && policy.perFolderLimit >= 0
        ? policy.perFolderLimit
        : Number.POSITIVE_INFINITY;

    const result: MaterialMeta[] = [];
    // 对每个文件夹独立抽取(单文件夹内仍受隔离保护)
    for (const fid of folderIds) {
      const all = materialsByFolder.get(fid) ?? [];
      let pool = all.slice();
      if (allowedKinds) {
        pool = pool.filter((m) => allowedKinds.has(m.kind));
      }
      shuffle(pool, createRng());
      result.push(...pool.slice(0, perLimit));
    }

    // 构造审计条目并经 warn 通道输出(logger.warn 会落入轮转日志文件)
    const entry: AuditEntry = {
      timestamp: nowFn().toISOString(),
      action: 'pickAcrossFolders',
      folderIds: folderIds.slice(),
      reason: policy.reason,
      policy,
      resultCount: result.length,
    };
    warnFn(`[AUDIT] 跨文件夹调用 ${JSON.stringify(entry)}`);

    return result;
  }

  return {
    registerFolder,
    removeFolder,
    scanFolder,
    listFolders,
    listMaterials,
    pickFromFolder,
    pickAcrossFolders,
  };
}

/**
 * 全局单例:供 IPC 层与生产环境直接使用
 * 测试中应使用 createMaterialRepo(...) 构造独立实例,避免污染全局状态
 */
export const materialRepo: MaterialRepo = createMaterialRepo();
