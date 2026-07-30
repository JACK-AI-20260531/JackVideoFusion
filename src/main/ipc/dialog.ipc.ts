/**
 * 对话框 IPC 服务
 * 职责:提供文件/目录选择对话框,供渲染层调用
 */
import { ipcMain, dialog, IpcMainInvokeEvent } from 'electron';
import { safeHandle } from '../../../electron/ipc';

/**
 * 注册对话框 IPC handlers
 */
export function register(ipc: typeof ipcMain): void {
  // 单文件/多文件选择
  safeHandle(ipc, 'dialog:openFile', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const params = (payload ?? {}) as { title?: string; filters?: { name: string; extensions: string[] }[]; multiple?: boolean };
    const result = await dialog.showOpenDialog({
      title: params.title ?? '选择文件',
      properties: params.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: params.filters ?? [
        { name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] },
        { name: '音频文件', extensions: ['mp3', 'wav', 'aac', 'flac'] },
        { name: '文本文件', extensions: ['txt', 'srt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths;
  });

  // 目录选择
  safeHandle(ipc, 'dialog:openDirectory', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const params = (payload ?? {}) as { title?: string };
    const result = await dialog.showOpenDialog({
      title: params.title ?? '选择目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 保存文件对话框
  safeHandle(ipc, 'dialog:saveFile', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const params = (payload ?? {}) as { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] };
    const result = await dialog.showSaveDialog({
      title: params.title ?? '保存文件',
      defaultPath: params.defaultPath,
      filters: params.filters ?? [{ name: '所有文件', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePath;
  });
}
