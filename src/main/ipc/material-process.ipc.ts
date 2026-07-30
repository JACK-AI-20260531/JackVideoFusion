/**
 * 素材处理 IPC 注册
 * 职责:注册 material-process:text-split 和 material-process:extract-subtitle 通道
 * 使用方式:在 electron/ipc/index.ts 的 registrars 数组中追加
 *   (ipc) => register(ipc)
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { splitText, extractSubtitle } from '../services/material-process';
import { logger } from '../utils/logger';

/**
 * 注册素材处理相关 IPC handlers
 * @param ipc ipcMain 实例(由 electron/ipc/index.ts 传入)
 */
export function register(ipc: typeof ipcMain): void {
  // ===== 文本分割 =====
  // payload: { text, charLimit, keepPunct, autoParagraph }
  // returns: { ok: true, data: string[] } | { ok: false, error: string }
  ipc.handle(
    'material-process:text-split',
    async (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = payload as {
        text: string;
        charLimit: number;
        keepPunct: boolean;
        autoParagraph: boolean;
      };
      // 入参校验
      if (!p || typeof p.text !== 'string' || typeof p.charLimit !== 'number') {
        return { ok: false, error: '参数无效:text/charLimit 必填' };
      }
      try {
        const segments = splitText(p.text, p.charLimit, {
          keepPunct: p.keepPunct ?? true,
          autoParagraph: p.autoParagraph ?? true,
        });
        return { ok: true, data: segments };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[IPC] material-process:text-split 失败: ${msg}`);
        return { ok: false, error: msg };
      }
    },
  );

  // ===== 字幕提取 =====
  // payload: { filePath, outputPath }
  // returns: { ok: true, data: string } | { ok: false, error: string }
  ipc.handle(
    'material-process:extract-subtitle',
    async (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = payload as { filePath: string; outputPath: string };
      // 入参校验
      if (!p || !p.filePath || !p.outputPath) {
        return { ok: false, error: '参数无效:filePath/outputPath 必填' };
      }
      try {
        const result = await extractSubtitle(p.filePath, p.outputPath);
        return { ok: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[IPC] material-process:extract-subtitle 失败: ${msg}`);
        return { ok: false, error: msg };
      }
    },
  );

  logger.info('[IPC] material-process 通道已注册(text-split, extract-subtitle)');
}
