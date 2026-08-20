/**
 * FFmpeg 进度推送
 * 通过 BrowserWindow.webContents.send('ffmpeg:progress', ...) 将进度广播到渲染层,
 * 渲染层 LogPanel 可通过 window.api.on('ffmpeg:progress', ...) 订阅。
 */
import { BrowserWindow } from 'electron';
import { logger } from '@main/utils/logger';
import type { FFmpegProgress } from './types';

/**
 * 推送进度到所有可见窗口的渲染层
 * 若当前无窗口,仅记录调试日志,避免推送丢失诊断信息
 * @param progress 进度信息
 */
export function emitProgress(progress: FFmpegProgress): void {
  // 防御:非 Electron 主进程环境(如纯 Node)下 BrowserWindow 不可用,直接跳过
  if (typeof BrowserWindow === 'undefined' || typeof BrowserWindow.getAllWindows !== 'function') {
    return;
  }
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    logger.debug(
      `[FFmpeg] 无可用窗口,跳过进度推送: taskId=${progress.taskId} stage=${progress.stage} percent=${progress.percent}`,
    );
    return;
  }
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('ffmpeg:progress', progress);
    }
  }
}
