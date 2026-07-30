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
  // LLM 配置(可选,云端模式用)
  llm: {
    provider: 'openai' | 'qwen' | 'ollama' | 'custom';
    endpoint: string;
    apiKey: string;
    model: string;
  };
}

// 默认配置(与主进程 defaults.ts DEFAULT_CONFIG 对齐,字段扩展)
const DEFAULT_CONFIG: AppConfig = {
  defaultExportDir: '',
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
  llm: {
    provider: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
  },
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
 * 深度合并两个配置对象(简单实现,与主进程 deepMerge 语义一致)
 * @param base 基础配置
 * @param patch 补丁配置
 * @returns 合并后的配置
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
      result[key] = { ...(result[key] as Record<string, unknown>), ...(patchValue as Record<string, unknown>) };
    } else {
      result[key] = patchValue;
    }
  }
  return result as unknown as AppConfig;
}

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig>(deepMergeConfig(DEFAULT_CONFIG, null));
  const loaded = ref(false);
  // 保存操作反馈消息(null 表示无消息)
  const message = ref<string | null>(null);

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
   * 保存配置到主进程
   * 调用 config:set IPC 持久化当前配置
   */
  async function save(): Promise<void> {
    const res = await getApi().invoke<{ config: Partial<AppConfig> }, AppConfig>(
      'config:set',
      { config: config.value },
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
   * 调用 config:reset IPC 后重新加载
   */
  async function reset(): Promise<void> {
    await getApi().invoke<unknown, AppConfig>('config:reset');
    await load();
    message.value = '已恢复默认配置';
    setTimeout(() => {
      message.value = null;
    }, 3000);
  }

  return { config, loaded, message, load, save, reset };
});
