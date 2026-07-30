/**
 * 通用能力 IPC 注册
 * 职责:将通用服务(分辨率、导出路径、日志订阅)暴露为 IPC 通道
 *       供渲染层通过 window.api.invoke('common:xxx', ...) 调用
 *
 * 通道列表:
 *   common:listResolutions     - 返回分辨率预设列表
 *   common:getDefaultExportDir - 返回默认导出目录
 *   log:subscribe              - 渲染层日志订阅(返回 true;实际日志通过 'log:append' 事件广播)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { RESOLUTION_PRESETS } from '../services/common/resolutions';
import { getDefaultExportDir } from '../services/common/paths';
import { logger } from '../utils/logger';

/**
 * 注册通用能力 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 返回分辨率预设列表
   * 返回: ResolutionInfo[]
   */
  safeHandle(ipc, 'common:listResolutions', () => {
    return RESOLUTION_PRESETS;
  });

  /**
   * 返回默认导出目录(userData/exports)
   * 返回: string
   */
  safeHandle(ipc, 'common:getDefaultExportDir', () => {
    return getDefaultExportDir();
  });

  /**
   * 渲染层日志订阅
   * 渲染层调用此通道声明需要接收日志,
   * 实际日志推送通过 BrowserWindow.webContents.send('log:append', entry) 广播,
   * 渲染层使用 window.api.on('log:append', handler) 接收。
   * 返回: true(占位,表示订阅成功)
   */
  safeHandle(ipc, 'log:subscribe', () => {
    logger.info('[IPC] 渲染层已订阅日志广播');
    return true;
  });
}
