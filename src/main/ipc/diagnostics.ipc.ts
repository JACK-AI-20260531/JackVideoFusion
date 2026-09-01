/**
 * 诊断包 IPC 注册(PRD-v1.7 FR-8)
 *
 * 通道列表:
 *   diagnostics:export - 导出诊断包(系统信息 + 脱敏配置 + 最近日志 zip)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { exportDiagnostics } from '../services/diagnostics';
import { logger } from '../utils/logger';

/**
 * 注册诊断包相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 导出诊断包
  safeHandle(ipc, 'diagnostics:export', async () => {
    const path = await exportDiagnostics();
    logger.info(`[IPC] diagnostics:export 诊断包已导出: ${path}`);
    return { path };
  });
}

// 默认导出 register,便于 electron/ipc/index.ts 通过动态 import 加载
export default register;
