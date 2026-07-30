/**
 * 配置服务核心实现
 * 职责:管理全局配置、参数模板、工程文件的持久化读写
 * 技术选型:electron-store(JSON 文件持久化),替代 better-sqlite3(原生编译失败)
 *
 * 注意:electron-store v10 为 ESM-only 模块,在 CommonJS 编译目标下
 *       必须使用动态 import() 加载,故所有方法设计为异步。
 */
import { app } from 'electron';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type {
  AppConfig,
  ConfigTemplate,
  ProjectFile,
} from './types';
import { createDefaultConfig, deepMerge } from './defaults';

// electron-store v10 为 ESM-only,类型在 CJS 下不兼容,定义本地接口绕过
type AnyStore = {
  get(key: string): any;
  set(key: string, value: unknown): void;
};

/**
 * 获取 userData 目录(防御性:app 未就绪时回退到 cwd)
 * @returns userData 绝对路径
 */
function getUserDataDir(): string {
  return app?.getPath?.('userData') ?? process.cwd();
}

/**
 * 获取配置文件目录:userData/config/
 * @returns 配置目录绝对路径
 */
function getConfigDir(): string {
  return join(getUserDataDir(), 'config');
}

/**
 * 获取工程文件目录:userData/projects/
 * @returns 工程目录绝对路径
 */
function getProjectsDir(): string {
  return join(getUserDataDir(), 'projects');
}

/**
 * 获取当前时间的 ISO 8601 字符串
 * @returns ISO 时间戳
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * electron-store 构造器的懒加载器(ESM 动态导入)
 * 缓存 Promise 避免重复加载
 */
let storeCtorPromise: Promise<new (opts: unknown) => unknown> | null = null;

/**
 * 获取 electron-store 构造器(单例)
 * @returns Store 类构造器
 */
async function getStoreCtor(): Promise<new (opts: unknown) => unknown> {
  if (storeCtorPromise === null) {
    storeCtorPromise = import('electron-store').then((mod) => mod.default);
  }
  return storeCtorPromise;
}

/**
 * 配置服务
 * 管理三类持久化数据:全局配置 / 参数模板 / 工程文件
 * 每个 Store 实例懒加载,首次访问时创建
 */
export class ConfigService {
  /** 全局配置 store 实例(懒加载) */
  private configStore: AnyStore | null = null;
  /** 参数模板 store 实例(懒加载) */
  private templatesStore: AnyStore | null = null;
  /** 工程文件 store 实例(懒加载) */
  private projectsStore: AnyStore | null = null;

  /* ==================== Store 懒加载器 ==================== */

  /**
   * 获取全局配置 store(首次调用时创建)
   * @returns config store 实例
   */
  private async getConfigStore(): Promise<AnyStore> {
    if (this.configStore === null) {
      const StoreCtor = await getStoreCtor();
      this.configStore = new StoreCtor({
        name: 'config',
        cwd: getConfigDir(),
        defaults: { config: createDefaultConfig() },
      }) as AnyStore;
      logger.info('[ConfigService] 全局配置 store 已初始化');
    }
    return this.configStore;
  }

  /**
   * 获取参数模板 store(首次调用时创建)
   * @returns templates store 实例
   */
  private async getTemplatesStore(): Promise<AnyStore> {
    if (this.templatesStore === null) {
      const StoreCtor = await getStoreCtor();
      this.templatesStore = new StoreCtor({
        name: 'templates',
        cwd: getConfigDir(),
        defaults: { templates: {} },
      }) as AnyStore;
      logger.info('[ConfigService] 参数模板 store 已初始化');
    }
    return this.templatesStore;
  }

  /**
   * 获取工程文件 store(首次调用时创建)
   * @returns projects store 实例
   */
  private async getProjectsStore(): Promise<AnyStore> {
    if (this.projectsStore === null) {
      const StoreCtor = await getStoreCtor();
      this.projectsStore = new StoreCtor({
        name: 'project',
        cwd: getProjectsDir(),
        defaults: { projects: {} },
      }) as AnyStore;
      logger.info('[ConfigService] 工程文件 store 已初始化');
    }
    return this.projectsStore;
  }

  /* ==================== 全局配置读写 ==================== */

  /**
   * 读取全局配置
   * @returns 当前完整配置(与默认值合并,确保字段完整)
   */
  async getConfig(): Promise<AppConfig> {
    const store = await this.getConfigStore();
    const stored = store.get('config');
    // 与默认值合并,防止旧版本数据缺少新字段
    return deepMerge(createDefaultConfig(), stored);
  }

  /**
   * 更新全局配置(深度合并,不覆盖未传入的字段)
   * @param patch 配置片段
   * @returns 合并后的完整配置
   */
  async setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const store = await this.getConfigStore();
    const current = store.get('config');
    const merged = deepMerge(deepMerge(createDefaultConfig(), current), patch);
    store.set('config', merged);
    logger.info('[ConfigService] 全局配置已更新');
    return merged;
  }

  /**
   * 将全局配置重置为默认值
   * @returns 默认配置
   */
  async resetConfig(): Promise<AppConfig> {
    const store = await this.getConfigStore();
    const defaults = createDefaultConfig();
    store.set('config', defaults);
    logger.info('[ConfigService] 全局配置已重置为默认值');
    return defaults;
  }

  /* ==================== 参数模板管理 ==================== */

  /**
   * 保存参数模板(同名覆盖)
   * @param name 模板名称
   * @param config 待保存的配置;不传则使用当前全局配置
   * @param description 模板描述
   * @returns 保存后的模板对象
   */
  async saveTemplate(
    name: string,
    config?: AppConfig,
    description?: string,
  ): Promise<ConfigTemplate> {
    const store = await this.getTemplatesStore();
    const templates = store.get('templates');
    const existing = templates[name];
    const template: ConfigTemplate = {
      name,
      description,
      config: config ?? (await this.getConfig()),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    templates[name] = template;
    store.set('templates', templates);
    logger.info(`[ConfigService] 参数模板 "${name}" 已保存`);
    return template;
  }

  /**
   * 加载参数模板
   * @param name 模板名称
   * @returns 模板中的配置;模板不存在返回 null
   */
  async loadTemplate(name: string): Promise<AppConfig | null> {
    const store = await this.getTemplatesStore();
    const templates = store.get('templates') as Record<string, ConfigTemplate>;
    const template = templates[name];
    if (!template) {
      logger.warn(`[ConfigService] 参数模板 "${name}" 不存在`);
      return null;
    }
    return deepMerge(createDefaultConfig(), template.config);
  }

  /**
   * 列出所有参数模板
   * @returns 模板数组(按更新时间降序)
   */
  async listTemplates(): Promise<ConfigTemplate[]> {
    const store = await this.getTemplatesStore();
    const templates = store.get('templates') as Record<string, ConfigTemplate>;
    return Object.values(templates).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * 删除参数模板
   * @param name 模板名称
   * @returns 是否删除成功
   */
  async deleteTemplate(name: string): Promise<boolean> {
    const store = await this.getTemplatesStore();
    const templates = store.get('templates') as Record<string, ConfigTemplate>;
    if (!templates[name]) {
      return false;
    }
    delete templates[name];
    store.set('templates', templates);
    logger.info(`[ConfigService] 参数模板 "${name}" 已删除`);
    return true;
  }

  /* ==================== 工程文件管理 ==================== */

  /**
   * 保存工程文件(同名覆盖)
   * @param name 工程名称
   * @param config 工程配置;不传则使用当前全局配置
   * @param data 工程自定义数据
   * @returns 保存后的工程文件对象
   */
  async saveProject(
    name: string,
    config?: AppConfig,
    data?: Record<string, unknown>,
  ): Promise<ProjectFile> {
    const store = await this.getProjectsStore();
    const projects = store.get('projects');
    const existing = projects[name];
    const project: ProjectFile = {
      id: existing?.id ?? randomUUID(),
      name,
      config: config ?? (await this.getConfig()),
      data: data ?? existing?.data ?? {},
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    projects[name] = project;
    store.set('projects', projects);
    logger.info(`[ConfigService] 工程文件 "${name}" 已保存`);
    return project;
  }

  /**
   * 加载工程文件
   * @param name 工程名称
   * @returns 工程文件对象;不存在返回 null
   */
  async loadProject(name: string): Promise<ProjectFile | null> {
    const store = await this.getProjectsStore();
    const projects = store.get('projects') as Record<string, ProjectFile>;
    const project = projects[name];
    if (!project) {
      logger.warn(`[ConfigService] 工程文件 "${name}" 不存在`);
      return null;
    }
    return project;
  }

  /**
   * 列出所有工程文件
   * @returns 工程文件数组(按更新时间降序)
   */
  async listProjects(): Promise<ProjectFile[]> {
    const store = await this.getProjectsStore();
    const projects = store.get('projects') as Record<string, ProjectFile>;
    return Object.values(projects).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * 删除工程文件
   * @param name 工程名称
   * @returns 是否删除成功
   */
  async deleteProject(name: string): Promise<boolean> {
    const store = await this.getProjectsStore();
    const projects = store.get('projects') as Record<string, ProjectFile>;
    if (!projects[name]) {
      return false;
    }
    delete projects[name];
    store.set('projects', projects);
    logger.info(`[ConfigService] 工程文件 "${name}" 已删除`);
    return true;
  }
}
