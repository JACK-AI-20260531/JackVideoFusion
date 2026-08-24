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
  /** 界面主题:dark=深色,light=淡色 */
  theme: 'dark' | 'light';
  /** 默认导出路径 */
  defaultExportDir: string;
  /** 默认分辨率 */
  defaultResolution: '720p' | '1080p' | '4k';
  /** 是否保留原画质 */
  keepOriginalQuality: boolean;
  /** 默认水印配置(与渲染层 WatermarkConfig 结构对齐,九宫格位置) */
  watermark: WatermarkConfig;
  /** 默认字幕配置(与渲染层 SubtitleStyleConfig 结构对齐) */
  subtitle: SubtitleStyleConfig;
  /** 任务队列并发数(默认 1,避免磁盘抢占) */
  taskConcurrency: number;
  /** 素材分割业务参数 */
  split: SplitConfig;
  /** TTS 业务参数 */
  tts: TtsConfig;
  /** 混剪业务参数 */
  mix: MixConfig;
  /** LLM 配置(可选,云端模式用) */
  llm: {
    provider: 'openai' | 'qwen' | 'ollama' | 'custom';
    endpoint: string;
    apiKey: string;
    model: string;
  };
}

/**
 * 水印位置(九宫格)
 */
export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * 水印配置(与渲染层 WatermarkConfig 结构对齐)
 */
export interface WatermarkConfig {
  /** 是否启用水印 */
  enabled: boolean;
  /** 水印类型:text=文本水印,image=图片水印 */
  type: 'text' | 'image';
  /** 文本内容(type=text)或图片路径(type=image) */
  content: string;
  /** 水印位置(九宫格) */
  position: WatermarkPosition;
  /** 透明度 0-100 */
  opacity: number;
  /** 水平边距(像素) */
  marginX: number;
  /** 垂直边距(像素) */
  marginY: number;
  /** 文本水印字体大小,默认 24 */
  fontSize?: number;
  /** 文本水印字体颜色,默认 white */
  fontColor?: string;
  /** 文本水印自定义字体文件路径(.ttf) */
  fontFile?: string;
  /** 图片水印缩放比例(0-1),默认 1 */
  scale?: number;
}

/**
 * 字幕样式配置(与渲染层 SubtitleStyleConfig 结构对齐)
 */
export interface SubtitleStyleConfig {
  /** 是否启用字幕 */
  enabled: boolean;
  /** 字体族 */
  fontFamily: string;
  /** 字体大小 */
  fontSize: number;
  /** 字体颜色(十六进制) */
  color: string;
  /** 是否启用描边 */
  outline: boolean;
  /** 是否启用阴影 */
  shadow: boolean;
  /** 对齐方式 */
  align: 'left' | 'center' | 'right';
}

/**
 * 素材分割业务参数配置
 */
export interface SplitConfig {
  /** 单片段时长(秒) */
  segmentSec: number;
  /** 是否保留原画质 */
  keepQuality: boolean;
  /** 是否去除原始音轨 */
  stripAudio: boolean;
  /** 命名规则模板({name}=原文件名, {index}=序号) */
  namingRule: string;
}

/**
 * TTS 业务参数配置
 */
export interface TtsConfig {
  /** 音色 */
  voice: string;
  /** 是否同时生成 SRT 字幕 */
  generateSrt: boolean;
}

/**
 * 混剪业务参数配置
 */
export interface MixConfig {
  /** 每文件夹抽取素材条数 */
  perFolderCount: number;
  /** 目标总时长(秒) */
  targetDurationSec: number;
  /** 是否不重复复用素材 */
  uniqueReuse: boolean;
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
 * 参数模板元数据(列表展示用,不含 config,避免经 IPC 传输无用大对象)
 */
export interface ConfigTemplateMeta {
  /** 模板名称(唯一标识) */
  name: string;
  /** 模板描述(可选) */
  description?: string;
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
