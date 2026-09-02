/**
 * 混剪参数模板 IPC 注册(PRD-v2.1 FR-1)
 * 职责:将 mixTemplateStore 的能力暴露为 mix-template:* 系列通道
 *
 * 通道列表:
 *   mix-template:save   - 保存(同名覆盖)
 *   mix-template:list   - 元数据列表(不含 params)
 *   mix-template:load   - 按名称取完整模板
 *   mix-template:delete - 按名称删除
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { mixTemplateStore, validateTemplateInput } from '../services/mix-template/template-store';
import type { MixParams } from '../services/video-mix/types';

/**
 * 注册混剪参数模板 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 保存模板(同名覆盖)
   * payload: { name: string, params: MixParams, description?: string }
   * 返回: MixTemplate
   */
  safeHandle(ipc, 'mix-template:save', async (_event, payload) => {
    const p = payload as { name?: string; params?: MixParams; description?: string } | undefined;
    if (!p?.name || !p.params) throw new Error('mix-template:save 参数无效:缺少 name/params');
    const err = validateTemplateInput(p.name, p.params);
    if (err) throw new Error(`mix-template:save 参数无效:${err}`);
    return mixTemplateStore.save(p.name, JSON.parse(JSON.stringify(p.params)), p.description);
  });

  /**
   * 元数据列表(不含 params,按更新时间降序)
   * 返回: MixTemplateMeta[]
   */
  safeHandle(ipc, 'mix-template:list', async () => {
    return mixTemplateStore.listMeta();
  });

  /**
   * 按名称取完整模板
   * payload: { name: string }
   * 返回: MixTemplate | null
   */
  safeHandle(ipc, 'mix-template:load', async (_event, payload) => {
    const p = payload as { name?: string } | undefined;
    if (!p?.name) throw new Error('mix-template:load 参数无效:缺少 name');
    return mixTemplateStore.get(p.name);
  });

  /**
   * 按名称删除模板
   * payload: { name: string }
   * 返回: boolean(是否删除成功)
   */
  safeHandle(ipc, 'mix-template:delete', async (_event, payload) => {
    const p = payload as { name?: string } | undefined;
    if (!p?.name) throw new Error('mix-template:delete 参数无效:缺少 name');
    return mixTemplateStore.remove(p.name);
  });
}
