/**
 * 日志广播服务
 * 职责:将主进程日志实时推送到所有渲染窗口
 *       由 logger.ts 自动调用,渲染层通过 window.api.on('log:append', ...) 订阅
 */
import { BrowserWindow } from 'electron';
import type { LogEntry } from '@shared/types';

/**
 * 向所有渲染窗口广播日志条目
 * 遍历当前所有 BrowserWindow,通过 webContents.send 推送 'log:append' 事件
 * 窗口已销毁时跳过,避免异常
 * @param entry 日志条目(含时间戳、级别、消息、来源模块)
 */
export function broadcastLog(entry: LogEntry): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('log:append', entry);
    }
  }
}
