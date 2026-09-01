/**
 * 配置默认值与合并工具
 * 职责:提供默认配置常量、深度合并函数,确保配置结构完整
 */
import type { AppConfig } from './types';
import { DEFAULT_VIRALITY_WEIGHTS } from '../ai-slice/calibrate';

/**
 * 默认全局配置(与渲染层 DEFAULT_CONFIG 保持一致)
 */
export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
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
    // fontFile / scale 可选,无默认
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
  // AI 剪辑素材兜底阈值(CLIP 匹配置信度低于该值时启用兜底画面)
  clipFallbackThreshold: 0.35,
  // 爆款评分五维权重默认值(数据飞轮自学习后会被覆盖)
  viralityWeights: { ...DEFAULT_VIRALITY_WEIGHTS },
};

/**
 * 判断值是否为普通对象(非数组、非 null)
 * @param value 待检测的值
 * @returns 是否为普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深度合并两个配置对象
 * - 普通对象递归合并
 * - 数组、原始值直接覆盖
 * - patch 中值为 undefined 的键被跳过(不覆盖 base)
 * @param base 基础配置(提供默认值)
 * @param patch 补丁配置(覆盖或追加)
 * @returns 合并后的完整配置
 */
export function deepMerge<T extends object>(base: T, patch: Partial<T> | undefined | null): T {
  if (!patch) return { ...base };
  const result = { ...base } as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;
  for (const key in patchRecord) {
    if (!Object.prototype.hasOwnProperty.call(patchRecord, key)) continue;
    const patchValue = patchRecord[key];
    if (patchValue === undefined) continue;
    if (isPlainObject(result[key]) && isPlainObject(patchValue)) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        patchValue as Record<string, unknown>,
      );
    } else {
      result[key] = patchValue;
    }
  }
  return result as T;
}

/**
 * 创建一份与默认配置完全独立的深拷贝
 * @returns 全新的默认配置对象
 */
export function createDefaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}
