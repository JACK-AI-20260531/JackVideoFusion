/**
 * 配置状态仓库
 * 职责:通过 IPC 加载/保存/重置全局配置,管理水印/字幕/分辨率等设置
 *       AppConfig 结构与主进程 config-service/defaults.ts 保持一致,
 *       watermark/subtitle 字段扩展为 WatermarkConfig/SubtitleStyleConfig(九宫格位置等)
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  WatermarkConfig,
  SubtitleStyleConfig,
  ResolutionPreset,
} from '@shared/types';

// 全局配置结构(与主进程 AppConfig 对齐并扩展 watermark/subtitle)
export interface AppConfig {
  // 界面主题:dark=深色,light=淡色
  theme: 'dark' | 'light';
  // 默认导出路径
  defaultExportDir: string;
  // 默认分辨率
  defaultResolution: ResolutionPreset;
  // 是否保留原画质
  keepOriginalQuality: boolean;
  // 默认水印配置(扩展为九宫格位置 + 边距)
  watermark: WatermarkConfig;
  // 默认字幕配置(扩展为含阴影/对齐)
  subtitle: SubtitleStyleConfig;
  // 任务队列并发数(默认 1,避免磁盘抢占)
  taskConcurrency: number;
  // 素材分割业务参数
  split: SplitConfig;
  // TTS 业务参数
  tts: TtsConfig;
  // 混剪业务参数
  mix: MixConfig;
  // LLM 配置(可选,云端模式用)
  llm: {
    provider: 'openai' | 'qwen' | 'ollama' | 'custom';
    endpoint: string;
    apiKey: string;
    model: string;
  };
  // CN-CLIP 模型目录(用户自定义,空则使用默认 userData/models)
  clipModelDir: string;
}

// 素材分割业务参数(与主进程 SplitConfig 对齐)
export interface SplitConfig {
  segmentSec: number;
  keepQuality: boolean;
  stripAudio: boolean;
  namingRule: string;
}

// TTS 业务参数(与主进程 TtsConfig 对齐)
export interface TtsConfig {
  voice: string;
  generateSrt: boolean;
}

// 混剪业务参数(与主进程 MixConfig 对齐)
export interface MixConfig {
  perFolderCount: number;
  targetDurationSec: number;
  uniqueReuse: boolean;
}

// 模板列表条目(与主进程 ConfigTemplate 对齐,仅取展示字段)
export interface ConfigTemplateMeta {
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

// 默认配置(与主进程 defaults.ts DEFAULT_CONFIG 对齐,字段扩展)
const DEFAULT_CONFIG: AppConfig = {
  // 默认深色主题
  theme: 'dark',
  // 默认导出路径
  defaultExportDir: '',
  // 默认分辨率
  defaultResolution: '1080p',
  keepOriginalQuality: true,
  watermark: {
    enabled: false,
    type: 'text',
    content: '',
    position: 'bottom-right',
    opacity: 80,
    marginX: 20,
    marginY: 20,
    fontSize: 24,
    fontColor: 'white',
  },
  subtitle: {
    enabled: true,
    fontFamily: '微软雅黑',
    fontSize: 24,
    color: '#ffffff',
    outline: true,
    shadow: false,
    align: 'center',
  },
  taskConcurrency: 1,
  split: {
    segmentSec: 10,
    keepQuality: true,
    stripAudio: false,
    namingRule: '{name}_{index}',
  },
  tts: {
    voice: '',
    generateSrt: false,
  },
  mix: {
    perFolderCount: 3,
    targetDurationSec: 0,
    uniqueReuse: true,
  },
  llm: {
    provider: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
  },
  clipModelDir: '',
};

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明(与 preload.ts ExposedApi 保持一致)
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 深度合并两个配置对象(递归所有键,与主进程 deepMerge 语义一致)
 * @param base 基础配置
 * @param patch 补丁配置
 * @returns 合并后的配置(不修改入参)
 */
function deepMergeConfig(base: AppConfig, patch: Partial<AppConfig> | undefined | null): AppConfig {
  if (!patch) return { ...base };
  const result = { ...base } as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;
  for (const key in patchRecord) {
    if (!Object.prototype.hasOwnProperty.call(patchRecord, key)) continue;
    const patchValue = patchRecord[key];
    if (patchValue === undefined) continue;
    if (
      typeof patchValue === 'object' &&
      patchValue !== null &&
      !Array.isArray(patchValue) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeConfig(
        result[key] as unknown as AppConfig,
        patchValue as Partial<AppConfig>,
      ) as unknown as Record<string, unknown>;
    } else {
      result[key] = patchValue;
    }
  }
  return result as unknown as AppConfig;
}

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig>(structuredClone(DEFAULT_CONFIG));
  const loaded = ref(false);
  // 保存操作反馈消息(null 表示无消息)
  const message = ref<string | null>(null);
  // 模板列表(config:listTemplates 结果,仅取展示所需字段)
  const templates = ref<ConfigTemplateMeta[]>([]);

  /**
   * 从主进程加载配置
   * 调用 config:get IPC,将返回的配置与默认值合并后赋值
   */
  async function load(): Promise<void> {
    const res = await getApi().invoke<unknown, AppConfig>('config:get');
    if (res.ok && res.data) {
      config.value = deepMergeConfig(DEFAULT_CONFIG, res.data);
    } else {
      config.value = deepMergeConfig(DEFAULT_CONFIG, null);
    }
    loaded.value = true;
  }

  /**
   * 将响应式配置转为可序列化的普通对象
   * Vue 响应式 Proxy 无法通过 Electron IPC 结构化克隆,必须先剥离为纯对象
   */
  function toPlainConfig(): AppConfig {
    return JSON.parse(JSON.stringify(config.value)) as AppConfig;
  }

  /**
   * 保存配置到主进程
   * 调用 config:set IPC 持久化当前配置
   */
  async function save(): Promise<void> {
    const res = await getApi().invoke<{ config: Partial<AppConfig> }, AppConfig>(
      'config:set',
      { config: toPlainConfig() },
    );
    if (res.ok) {
      message.value = '配置已保存';
    } else {
      message.value = `保存失败: ${res.error ?? '未知错误'}`;
    }
    // 3 秒后自动清除消息
    setTimeout(() => {
      message.value = null;
    }, 3000);
  }

  /**
   * 重置配置为默认值
   * 调用 config:reset IPC,成功后再重新加载并反馈
   */
  async function reset(): Promise<void> {
    const res = await getApi().invoke<unknown, AppConfig>('config:reset');
    if (res.ok) {
      message.value = '已恢复默认配置';
      await load();
    } else {
      message.value = `重置失败: ${res.error ?? '未知错误'}`;
    }
    clearMessageSoon();
  }

  /**
   * 保存当前配置为模板
   * @param name 模板名(唯一)
   * @param description 描述
   * @returns 是否保存成功
   */
  async function saveTemplate(name: string, description?: string): Promise<boolean> {
    const res = await getApi().invoke<
      { name: string; description?: string; config?: AppConfig },
      ConfigTemplateMeta
    >('config:saveTemplate', {
      name,
      description: description || undefined,
      config: toPlainConfig(),
    });
    message.value = res.ok ? `模板「${name}」已保存` : `保存模板失败: ${res.error ?? '未知错误'}`;
    clearMessageSoon();
    if (res.ok) await listTemplates();
    return res.ok;
  }

  /**
   * 套用模板到当前配置
   * @param name 模板名
   * @returns 是否套用成功
   */
  async function loadTemplate(name: string): Promise<boolean> {
    const res = await getApi().invoke<{ name: string }, AppConfig>('config:loadTemplate', {
      name,
    });
    if (res.ok && res.data) {
      config.value = deepMergeConfig(DEFAULT_CONFIG, res.data);
      message.value = `已套用模板「${name}」,请点击"保存设置"持久化`;
    } else {
      message.value = `加载模板失败: ${res.error ?? '未知错误'}`;
    }
    clearMessageSoon();
    return res.ok && !!res.data;
  }

  /**
   * 刷新模板列表
   */
  async function listTemplates(): Promise<void> {
    const res = await getApi().invoke<unknown, ConfigTemplateMeta[]>('config:listTemplates');
    templates.value = res.ok && Array.isArray(res.data) ? res.data : [];
  }

  /**
   * 删除模板
   * @param name 模板名
   * @returns 是否删除成功
   */
  async function deleteTemplate(name: string): Promise<boolean> {
    const res = await getApi().invoke<{ name: string }, boolean>('config:deleteTemplate', { name });
    if (res.ok) {
      message.value = `模板「${name}」已删除`;
      await listTemplates();
    } else {
      message.value = `删除模板失败: ${res.error ?? '未知错误'}`;
    }
    clearMessageSoon();
    return res.ok;
  }

  /**
   * 3 秒后清除操作反馈消息
   */
  function clearMessageSoon(): void {
    setTimeout(() => {
      message.value = null;
    }, 3000);
  }

  return { config, loaded, message, templates, load, save, reset, saveTemplate, loadTemplate, listTemplates, deleteTemplate };
});
