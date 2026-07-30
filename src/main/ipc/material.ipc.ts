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
    return { removed: folderId };
  });

  // 扫描文件夹素材
  safeHandle(ipc, 'material:scanFolder', async (_event, payload: unknown) => {
    const { folderId } = payload as { folderId: string };
    if (!folderId || typeof folderId !== 'string') {
      throw new Error('material:scanFolder 入参缺失 folderId');
    }
    return materialRepo.scanFolder(folderId);
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
}

// 默认导出 register,便于 electron/ipc/index.ts 通过动态 import 加载
export default register;
