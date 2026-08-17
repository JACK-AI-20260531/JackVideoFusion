/**
 * Shell IPC 注册
 * 职责:提供“在系统文件管理器中显示文件”与“用系统默认应用打开路径”能力
 */
import type { ipcMain } from 'electron';
import { shell } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { extractPath } from './shell-helper';

/**
 * 注册 shell 相关 IPC handlers
 * 通道:
 *   shell:showItemInFolder - 在文件管理器中定位并选中文件
 *   shell:openPath         - 用系统默认应用打开文件/目录
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 在文件管理器中显示并选中目标
  safeHandle(ipc, 'shell:showItemInFolder', (_event, payload) => {
    const path = extractPath(payload);
    if (!path) {
      return { shown: false, reason: 'empty-path' };
    }
    shell.showItemInFolder(path);
    return { shown: true };
  });

  // 用系统默认应用打开路径
  safeHandle(ipc, 'shell:openPath', async (_event, payload) => {
    const path = extractPath(payload);
    if (!path) {
      return { opened: false, reason: 'empty-path' };
    }
    const error = await shell.openPath(path);
    if (error) {
      throw new Error(error);
    }
    return { opened: true };
  });
}
