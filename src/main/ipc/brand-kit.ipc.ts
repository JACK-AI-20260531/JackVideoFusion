/**
 * 品牌套件 IPC 注册(PRD-v1.7 FR-7)
 *
 * 通道列表:
 *   brand:get - 读取品牌配置
 *   brand:set - 更新品牌配置(浅合并)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { brandStore } from '../services/brand-kit';
import type { BrandKitConfig } from '../services/brand-kit';

/**
 * 注册品牌套件相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 读取品牌配置
  safeHandle(ipc, 'brand:get', () => {
    return brandStore.getConfig();
  });

  // 更新品牌配置(浅合并,未传字段保持不变)
  safeHandle(ipc, 'brand:set', (_event, payload: unknown) => {
    const patch = payload as Partial<BrandKitConfig>;
    if (!patch || typeof patch !== 'object') {
      throw new Error('brand:set 入参无效:必须为配置对象');
    }
    return brandStore.setConfig(patch);
  });
}

// 默认导出 register,便于 electron/ipc/index.ts 通过动态 import 加载
export default register;
