/**
 * 配置服务类型定义
 * 职责:定义全局配置、参数模板、工程文件的数据结构
 * 注意:AppConfig 接口与 src/renderer/stores/config.ts 中的定义保持结构兼容,
 *      不可直接 import 渲染层代码(架构边界),故在此独立声明。
 */

/**
 * 全局应用配置(结构必须与渲染层 AppConfig 一致)
 */
export interface AppConfig {
  /** 默认导出路径 */
  defaultExportDir: string;
  /** 默认分辨率 */
  defaultResolution: '720p' | '1080p' | '4k';
  /** 是否保留原画质 */
  keepOriginalQuality: boolean;
  /** 默认水印配置 */
  watermark: {
    enabled: boolean;
    type: 'text' | 'image';
    content: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
    opacity: number;
  };
  /** 默认字幕配置 */
  subtitle: {
    enabled: boolean;
    fontFamily: string;
    fontSize: number;
    color: string;
    outline: boolean;
  };
  /** 任务队列并发数(默认 1,避免磁盘抢占) */
  taskConcurrency: number;
  /** LLM 配置(可选,云端模式用) */
  llm: {
    provider: 'openai' | 'qwen' | 'ollama' | 'custom';
    endpoint: string;
    apiKey: string;
    model: string;
  };
}

/**
 * 参数模板(命名的配置快照,可复用)
 */
export interface ConfigTemplate {
  /** 模板名称(唯一标识) */
  name: string;
  /** 模板描述(可选) */
  description?: string;
  /** 配置内容 */
  config: AppConfig;
  /** 创建时间(ISO 8601) */
  createdAt: string;
  /** 最后更新时间(ISO 8601) */
  updatedAt: string;
}

/**
 * 工程文件(保存完整工程状态:配置 + 自定义数据)
 */
export interface ProjectFile {
  /** 工程唯一 ID */
  id: string;
  /** 工程名称(唯一标识) */
  name: string;
  /** 工程配置 */
  config: AppConfig;
  /** 工程自定义数据(素材引用、任务引用等,供后续 Task 扩展) */
  data: Record<string, unknown>;
  /** 创建时间(ISO 8601) */
  createdAt: string;
  /** 最后更新时间(ISO 8601) */
  updatedAt: string;
}

/**
 * 全局配置 store 数据结构(单一配置文件)
 */
export interface ConfigStoreData {
  config: AppConfig;
}

/**
 * 参数模板 store 数据结构(模板表)
 */
export interface TemplatesStoreData {
  templates: Record<string, ConfigTemplate>;
}

/**
 * 工程文件 store 数据结构(工程表)
 */
export interface ProjectsStoreData {
  projects: Record<string, ProjectFile>;
}

/* ==================== IPC 请求 Payload 类型 ==================== */

/** config:get 请求 */
export interface ConfigGetPayload {
  /** 可选,指定键则返回子键值;不传则返回完整配置 */
  key?: keyof AppConfig;
}

/** config:set 请求 */
export interface ConfigSetPayload {
  /** 待合并的配置片段 */
  config: Partial<AppConfig>;
}

/** config:saveTemplate 请求 */
export interface SaveTemplatePayload {
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description?: string;
  /** 待保存的配置;不传则使用当前全局配置 */
  config?: AppConfig;
}

/** config:loadTemplate 请求 */
export interface LoadTemplatePayload {
  /** 模板名称 */
  name: string;
}

/** config:deleteTemplate 请求 */
export interface DeleteTemplatePayload {
  /** 模板名称 */
  name: string;
}

/** config:saveProject 请求 */
export interface SaveProjectPayload {
  /** 工程名称 */
  name: string;
  /** 工程配置;不传则使用当前全局配置 */
  config?: AppConfig;
  /** 工程自定义数据 */
  data?: Record<string, unknown>;
}

/** config:loadProject 请求 */
export interface LoadProjectPayload {
  /** 工程名称 */
  name: string;
}

/** config:deleteProject 请求 */
export interface DeleteProjectPayload {
  /** 工程名称 */
  name: string;
}
