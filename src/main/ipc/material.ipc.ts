/**
 * 素材仓库 IPC 通道注册
 * 职责:将 materialRepo 的能力暴露给渲染层,使用 safeHandle 统一错误处理
 * 通道列表:
 *   material:addFolder        注册文件夹(拖拽导入/手动添加共用)
 *   material:removeFolder     移除文件夹
 *   material:scanFolder       扫描文件夹素材
 *   material:listFolders      列出已注册文件夹
 *   material:listMaterials    列出指定文件夹的素材
 *   material:pickFromFolder   单文件夹抽取(隔离 API)
 *   material:pickAcrossFolders 跨文件夹抽取(审计 API)
 *
 * 注意:本文件只声明注册函数,实际挂载由 electron/ipc/index.ts 的 registerAllIpc 统一调度
 *       (Task 004 不修改 electron/ipc/index.ts,集成任务会自动加入此 registrar)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { materialRepo } from '../services/material-repo';
import { semanticIndexStore } from '../services/semantic/index-store';
import { logger } from '../utils/logger';
import {
  usageTracker,
  dedupStore,
  computeHashes,
  groupDuplicates,
  tagsStore,
  filterMaterials,
} from '../services/material-repo';
import type { PickOpts, WhitelistPolicy } from '../services/material-repo/types';
import type { MaterialMeta } from '../../shared/types';

/**
 * 注册素材相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 注册文件夹(拖拽导入 / 手动添加双通道共用此 handler)
  safeHandle(ipc, 'material:addFolder', async (_event, payload: unknown) => {
    const { path } = payload as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('material:addFolder 入参缺失 path');
    }
    return materialRepo.registerFolder(path);
  });

  // 移除文件夹
  safeHandle(ipc, 'material:removeFolder', (_event, payload: unknown) => {
    const { folderId } = payload as { folderId: string };
    if (!folderId || typeof folderId !== 'string') {
      throw new Error('material:removeFolder 入参缺失 folderId');
    }
    materialRepo.removeFolder(folderId);
    // 联动清理该文件夹的语义索引(PRD-v2.1 FR-4)
    semanticIndexStore.removeWhere((e) => e.folderId === folderId);
    return { removed: folderId };
  });

  // 扫描文件夹素材
  safeHandle(ipc, 'material:scanFolder', async (_event, payload: unknown) => {
    const { folderId } = payload as { folderId: string };
    if (!folderId || typeof folderId !== 'string') {
      throw new Error('material:scanFolder 入参缺失 folderId');
    }
    const list = await materialRepo.scanFolder(folderId);
    // 重扫后清理已消失素材的语义索引(断点续建会跳过仍存在的,PRD-v2.1 FR-4)
    const currentIds = new Set(list.map((m) => m.id));
    semanticIndexStore.removeWhere((e) => e.folderId === folderId && !currentIds.has(e.materialId));
    return list;
  });

  // 列出已注册文件夹
  safeHandle(ipc, 'material:listFolders', () => {
    return materialRepo.listFolders();
  });

  // 列出指定文件夹的素材
  safeHandle(ipc, 'material:listMaterials', (_event, payload: unknown) => {
    const { folderId } = payload as { folderId: string };
    if (!folderId || typeof folderId !== 'string') {
      throw new Error('material:listMaterials 入参缺失 folderId');
    }
    return materialRepo.listMaterials(folderId);
  });

  // 单文件夹抽取(核心隔离 API)
  safeHandle(ipc, 'material:pickFromFolder', (_event, payload: unknown) => {
    const p = payload as {
      folderId: string;
      count: number;
      opts?: PickOpts;
    };
    if (!p || !p.folderId || typeof p.count !== 'number') {
      throw new Error('material:pickFromFolder 入参缺失 folderId 或 count');
    }
    const picked: MaterialMeta[] = materialRepo.pickFromFolder(
      p.folderId,
      p.count,
      p.opts,
    );
    return picked;
  });

  // 跨文件夹抽取(强制审计)
  safeHandle(ipc, 'material:pickAcrossFolders', (_event, payload: unknown) => {
    const p = payload as {
      folderIds: string[];
      policy: WhitelistPolicy;
    };
    if (!p || !Array.isArray(p.folderIds) || !p.policy) {
      throw new Error('material:pickAcrossFolders 入参缺失 folderIds 或 policy');
    }
    return materialRepo.pickAcrossFolders(p.folderIds, p.policy);
  });

  /**
   * 素材使用统计(路径 → {count, lastUsedAt};PRD-v1.7 FR-5)
   */
  safeHandle(ipc, 'material:usageStats', () => {
    return usageTracker.list();
  });

  /**
   * 文件夹查重:逐条计算感知哈希(dHash)并返回重复分组(尽力而为)
   * payload: { folderId }
   */
  safeHandle(ipc, 'material:dedupScan', async (_event, payload: unknown) => {
    const { folderId } = payload as { folderId: string };
    if (!folderId || typeof folderId !== 'string') {
      throw new Error('material:dedupScan 入参缺失 folderId');
    }
    const materials = materialRepo.listMaterials(folderId);
    const { computed, failed } = await computeHashes(materials.map((m) => m.path));
    const groups = groupDuplicates(dedupStore.list());
    logger.info(`[IPC] material:dedupScan 文件夹 ${folderId}: ${computed} 成功, ${failed} 失败`);
    return { scanned: materials.length, computed, failed, groups };
  });

  /**
   * 设置素材标签(覆盖式;空数组清除)
   * payload: { path, tags }
   */
  safeHandle(ipc, 'material:setTags', (_event, payload: unknown) => {
    const { path, tags } = payload as { path: string; tags: unknown };
    if (!path || typeof path !== 'string') {
      throw new Error('material:setTags 入参缺失 path');
    }
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('material:setTags 入参无效:tags 必须为字符串数组');
    }
    tagsStore.setTags(path, tags as string[]);
    return { path, tags: tagsStore.getTags(path) };
  });

  /**
   * 素材筛选(按标签/最小使用次数)
   * payload: { folderId, tag?, minUsage? }
   */
  safeHandle(ipc, 'material:searchMaterials', (_event, payload: unknown) => {
    const p = payload as {
      folderId: string;
      tag?: string;
      minUsage?: number;
    };
    if (!p || !p.folderId || typeof p.folderId !== 'string') {
      throw new Error('material:searchMaterials 入参缺失 folderId');
    }
    const materials = materialRepo.listMaterials(p.folderId);
    return filterMaterials(materials, usageTracker.list(), tagsStore.list(), {
      tag: p.tag,
      minUsage: typeof p.minUsage === 'number' && p.minUsage > 0 ? p.minUsage : 0,
    });
  });
}

// 默认导出 register,便于 electron/ipc/index.ts 通过动态 import 加载
export default register;
