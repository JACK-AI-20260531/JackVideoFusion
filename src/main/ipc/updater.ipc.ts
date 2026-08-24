/**
 * 自动更新 IPC 注册
 *
 * 职责:将 updater 服务暴露为 updater:* 系列通道,供渲染层「系统设置-关于」区域调用。
 *
 * 通道列表:
 *   updater:status  - 查询当前更新状态(首次挂载同步)
 *   updater:check   - 触发检查更新
 *   updater:download- 触发下载更新
 *   updater:install - 安装并重启
 *
 * 进度推送:通过 'updater:progress' 事件广播(BrowserWindow.webContents.send),
 *           渲染层用 window.api.on('updater:progress', handler) 订阅。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import {
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  getUpdateStatus,
  type UpdaterProgressPayload,
} from '../services/updater';

/**
 * 注册自动更新 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 查询当前更新状态
   * 返回: UpdaterProgressPayload
   */
  safeHandle(ipc, 'updater:status', () => {
    return getUpdateStatus();
  });

  /**
   * 触发检查更新
   * 返回: UpdaterProgressPayload(检查结果)
   */
  safeHandle(ipc, 'updater:check', async () => {
    return checkForUpdates();
  });

  /**
   * 触发下载更新
   * 返回: UpdaterProgressPayload(下载进度/状态)
   */
  safeHandle(ipc, 'updater:download', async () => {
    return downloadUpdate();
  });

  /**
   * 安装并重启
   * 返回: boolean(是否已触发安装)
   */
  safeHandle(ipc, 'updater:install', async () => {
    return installAndRestart();
  });
}

/** 导出类型供渲染层复用 */
export type { UpdaterProgressPayload };
