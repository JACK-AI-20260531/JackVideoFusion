/**
 * 配置服务 IPC 注册
 * 职责:将 ConfigService 的方法暴露为 config:* 系列 IPC 通道
 *       供渲染层通过 ipcRenderer.invoke('config:xxx', payload) 调用
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { getConfigService } from '../services/config-service';
import type {
  ConfigGetPayload,
  ConfigSetPayload,
  DeleteProjectPayload,
  DeleteTemplatePayload,
  LoadProjectPayload,
  LoadTemplatePayload,
  SaveProjectPayload,
  SaveTemplatePayload,
} from '../services/config-service';

/**
 * 注册配置服务 IPC handlers
 * 通道列表:
 *   config:get           - 读取全局配置
 *   config:set           - 更新全局配置(深度合并)
 *   config:reset         - 重置为默认配置
 *   config:saveTemplate  - 保存参数模板
 *   config:loadTemplate  - 加载参数模板
 *   config:listTemplates - 列出所有参数模板
 *   config:deleteTemplate- 删除参数模板
 *   config:saveProject   - 保存工程文件
 *   config:loadProject   - 加载工程文件
 *   config:listProjects  - 列出所有工程文件
 *   config:deleteProject - 删除工程文件
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  const service = getConfigService();

  /* ==================== 全局配置 ==================== */

  /**
   * 读取全局配置
   * payload: { key?: keyof AppConfig } — 可选指定键
   * 返回: AppConfig | AppConfig[K]
   */
  safeHandle(ipc, 'config:get', async (_event, payload) => {
    const p = payload as ConfigGetPayload | undefined;
    const config = await service.getConfig();
    if (p?.key) {
      return config[p.key];
    }
    return config;
  });

  /**
   * 更新全局配置(深度合并)
   * payload: { config: Partial<AppConfig> }
   * 返回: 合并后的完整 AppConfig
   */
  safeHandle(ipc, 'config:set', async (_event, payload) => {
    const p = payload as ConfigSetPayload;
    if (!p || typeof p.config !== 'object' || p.config === null) {
      throw new Error('config:set 参数无效:缺少 config 对象');
    }
    return service.setConfig(p.config);
  });

  /**
   * 重置全局配置为默认值
   * 返回: 默认 AppConfig
   */
  safeHandle(ipc, 'config:reset', async () => {
    return service.resetConfig();
  });

  /* ==================== 参数模板 ==================== */

  /**
   * 保存参数模板
   * payload: { name: string, config?: AppConfig, description?: string }
   * 返回: 保存后的 ConfigTemplate
   */
  safeHandle(ipc, 'config:saveTemplate', async (_event, payload) => {
    const p = payload as SaveTemplatePayload;
    if (!p?.name) {
      throw new Error('config:saveTemplate 参数无效:缺少 name');
    }
    return service.saveTemplate(p.name, p.config, p.description);
  });

  /**
   * 加载参数模板
   * payload: { name: string }
   * 返回: 模板中的 AppConfig;不存在返回 null
   */
  safeHandle(ipc, 'config:loadTemplate', async (_event, payload) => {
    const p = payload as LoadTemplatePayload;
    if (!p?.name) {
      throw new Error('config:loadTemplate 参数无效:缺少 name');
    }
    return service.loadTemplate(p.name);
  });

  /**
   * 列出所有参数模板(仅元数据,不含 config)
   * 返回: ConfigTemplateMeta[](按更新时间降序)
   */
  safeHandle(ipc, 'config:listTemplates', async () => {
    return service.listTemplatesMeta();
  });

  /**
   * 删除参数模板
   * payload: { name: string }
   * 返回: boolean(是否删除成功)
   */
  safeHandle(ipc, 'config:deleteTemplate', async (_event, payload) => {
    const p = payload as DeleteTemplatePayload;
    if (!p?.name) {
      throw new Error('config:deleteTemplate 参数无效:缺少 name');
    }
    return service.deleteTemplate(p.name);
  });

  /* ==================== 工程文件 ==================== */

  /**
   * 保存工程文件
   * payload: { name: string, config?: AppConfig, data?: Record<string, unknown> }
   * 返回: 保存后的 ProjectFile
   */
  safeHandle(ipc, 'config:saveProject', async (_event, payload) => {
    const p = payload as SaveProjectPayload;
    if (!p?.name) {
      throw new Error('config:saveProject 参数无效:缺少 name');
    }
    return service.saveProject(p.name, p.config, p.data);
  });

  /**
   * 加载工程文件
   * payload: { name: string }
   * 返回: ProjectFile;不存在返回 null
   */
  safeHandle(ipc, 'config:loadProject', async (_event, payload) => {
    const p = payload as LoadProjectPayload;
    if (!p?.name) {
      throw new Error('config:loadProject 参数无效:缺少 name');
    }
    return service.loadProject(p.name);
  });

  /**
   * 列出所有工程文件
   * 返回: ProjectFile[](按更新时间降序)
   */
  safeHandle(ipc, 'config:listProjects', async () => {
    return service.listProjects();
  });

  /**
   * 删除工程文件
   * payload: { name: string }
   * 返回: boolean(是否删除成功)
   */
  safeHandle(ipc, 'config:deleteProject', async (_event, payload) => {
    const p = payload as DeleteProjectPayload;
    if (!p?.name) {
      throw new Error('config:deleteProject 参数无效:缺少 name');
    }
    return service.deleteProject(p.name);
  });
}
