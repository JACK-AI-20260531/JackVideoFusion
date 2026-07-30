/**
 * 配置状态仓库
 * 职责:加载/保存默认参数、参数模板,所有表单可一键还原默认
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

// 全局配置结构
export interface AppConfig {
  // 默认导出路径
  defaultExportDir: string;
  // 默认分辨率
  defaultResolution: '720p' | '1080p' | '4k';
  // 是否保留原画质
  keepOriginalQuality: boolean;
  // 默认水印配置
  watermark: {
    enabled: boolean;
    type: 'text' | 'image';
    content: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
    opacity: number;
  };
  // 默认字幕配置
  subtitle: {
    enabled: boolean;
    fontFamily: string;
    fontSize: number;
    color: string;
    outline: boolean;
  };
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

// 默认配置
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
  },
  subtitle: {
    enabled: true,
    fontFamily: '微软雅黑',
    fontSize: 24,
    color: '#ffffff',
    outline: true,
  },
  taskConcurrency: 1,
  llm: {
    provider: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
  },
};

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig>({ ...DEFAULT_CONFIG });
  const loaded = ref(false);

  // 从主进程加载配置
  async function load(): Promise<void> {
    // TODO: 通过 IPC 调用 config-service 加载持久化配置
    loaded.value = true;
  }
  // 保存配置到主进程
  async function save(): Promise<void> {
    // TODO: 通过 IPC 调用 config-service 持久化
  }
  // 还原默认值
  function reset(): void {
    config.value = { ...DEFAULT_CONFIG };
  }

  return { config, loaded, load, save, reset };
});
