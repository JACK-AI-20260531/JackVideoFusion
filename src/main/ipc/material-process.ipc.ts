/**
 * 素材处理 IPC 注册
 * 职责:注册 material-process:text-split 和 material-process:extract-subtitle 通道
 * 使用方式:在 electron/ipc/index.ts 的 registrars 数组中追加
 *   (ipc) => register(ipc)
 */
import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import { splitText, extractSubtitle, listVideoFiles } from '../services/material-process';
import { extractSubtitleOcr } from '../services/ocr';
import type { OcrParams } from '../services/ocr/types';
import { CancelToken } from '../services/ffmpeg/types';
import { logger } from '../utils/logger';

/**
 * 进行中 OCR 任务的取消令牌(以 requestId 为键),供 cancel-ocr 通道中断单个长任务
 */
const ocrCancelers = new Map<string, CancelToken>();

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

  // ===== OCR 字幕识别(内嵌字幕流缺失时识别画面文字) =====
  // payload: OcrParams
  // returns: { ok: true, data: string } | { ok: false, error: string }
  ipc.handle(
    'material-process:extract-subtitle-ocr',
    async (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = payload as OcrParams;
      // 入参校验
      if (!p || typeof p.videoPath !== 'string' || typeof p.outputPath !== 'string') {
        return { ok: false, error: '参数无效:videoPath/outputPath 必填' };
      }
      const p0 = p as OcrParams & { requestId?: string };
      const reqId = p0.requestId ?? `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const token = new CancelToken(reqId);
      ocrCancelers.set(reqId, token);
      try {
        const result = await extractSubtitleOcr({
          params: { ...p, requestId: reqId },
          token,
          onProgress: (progress, phase) => {
            logger.info(`[OCR] ${phase}(${Math.round(progress * 100)}%)`);
            // 把进度广播给渲染层,便于实时展示(带 requestId 关联)
            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('material-process:ocr-progress', {
                requestId: reqId,
                percent: Math.round(progress * 100),
                phase,
              });
            }
          },
        });
        return { ok: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[IPC] material-process:extract-subtitle-ocr 失败: ${msg}`);
        return { ok: false, error: msg };
      } finally {
        ocrCancelers.delete(reqId);
      }
    },
  );

  // ===== 取消进行中的 OCR 识别任务 =====
  // payload: { requestId }
  // returns: { ok: true, data: { cancelled: boolean } }
  ipc.handle(
    'material-process:cancel-ocr',
    (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = payload as { requestId?: string };
      if (!p || typeof p.requestId !== 'string' || !p.requestId) {
        return { ok: false, error: '参数无效:requestId 必填' };
      }
      const token = ocrCancelers.get(p.requestId);
      if (!token) {
        return { ok: false, error: '未找到对应 OCR 任务(可能已完成)' };
      }
      token.cancel('用户取消 OCR 识别');
      logger.info(`[IPC] material-process:cancel-ocr requestId=${p.requestId}`);
      return { ok: true, data: { cancelled: true } };
    },
  );

  // ===== 列出目录下视频文件(供“导入文件夹”批量选择) =====
  // payload: { dirPath }
  // returns: { ok: true, data: string[] } | { ok: false, error: string }
  ipc.handle(
    'material-process:list-video-files',
    async (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = payload as { dirPath?: string };
      if (!p || typeof p.dirPath !== 'string' || !p.dirPath) {
        return { ok: false, error: '参数无效:dirPath 必填' };
      }
      try {
        return { ok: true, data: listVideoFiles(p.dirPath) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[IPC] material-process:list-video-files 失败: ${msg}`);
        return { ok: false, error: msg };
      }
    },
  );

  logger.info('[IPC] material-process 通道已注册(text-split, extract-subtitle, extract-subtitle-ocr, cancel-ocr, list-video-files)');
}
