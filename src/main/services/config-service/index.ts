/**
 * 配置服务模块入口
 * 职责:导出 ConfigService 单例与相关类型,供 IPC 层与其他服务调用
 *       同时重新导出任务存储接口(持久化层统一入口,供 Task 005 调用)
 */
export { ConfigService } from './config-service';
export {
  DEFAULT_CONFIG,
  createDefaultConfig,
  deepMerge,
} from './defaults';
export type {
  AppConfig,
  ConfigTemplate,
  ProjectFile,
  ConfigStoreData,
  TemplatesStoreData,
  ProjectsStoreData,
  ConfigGetPayload,
  ConfigSetPayload,
  SaveTemplatePayload,
  LoadTemplatePayload,
  DeleteTemplatePayload,
  SaveProjectPayload,
  LoadProjectPayload,
  DeleteProjectPayload,
} from './types';

// 重新导出任务存储接口与单例(持久化层统一入口,供 Task 005 调用)
export { getTaskStore } from '../storage';
export type { ITaskStore, TaskRecord, TaskListFilter } from '../storage';

import { ConfigService } from './config-service';

/** 单例实例(懒加载) */
let configServiceInstance: ConfigService | null = null;

/**
 * 获取 ConfigService 单例
 * 首次调用时创建实例;Store 实例在首次访问时才初始化(app ready 后)
 * @returns ConfigService 单例
 */
export function getConfigService(): ConfigService {
  if (configServiceInstance === null) {
    configServiceInstance = new ConfigService();
  }
  return configServiceInstance;
}
