/**
 * 品牌套件(PRD-v1.7 数据飞轮与全景矩阵 FR-7)
 *
 * 职责:
 *   - 全局品牌配置的持久化(brand.json):品牌水印/片头片尾/统一滤镜/目标比例
 *   - 纯函数 buildBrandFilter:把品牌配置编译为 ffmpeg -vf 滤镜链(eq �色感 + scale/pad 比例)
 *
 * 设计要点:
 *   - 滤镜链与混剪的分辨率 scale 滤镜以逗号拼接一次转码,不二次编码
 *   - 片头片尾由混剪管线以分段形式拼入(异源走 filter concat,天然兼容)
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';

/** 品牌套件配置(全部字段可选,空配置 = 不应用) */
export interface BrandKitConfig {
  /** 品牌水印图片路径(params.watermark 未启用时应用) */
  watermarkImage?: string;
  /** 品牌水印位置(九宫格,默认 bottom-right) */
  watermarkPosition?: 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /** 品牌水印不透明度(0-100,默认 80) */
  watermarkOpacity?: number;
  /** 片头视频片段路径(可选) */
  introPath?: string;
  /** 片尾视频片段路径(可选) */
  outroPath?: string;
  /** 统一色感滤镜(可选;brightness [-1,1] / contrast [0,2] / saturation [0,2]) */
  filter?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
  /** 目标画面比例(none = 不调整) */
  aspect?: '9:16' | '16:9' | 'none';
}

/** 各比例对应的目标分辨率 */
const ASPECT_SIZES: Record<'9:16' | '16:9', [number, number]> = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
};

/** BrandStore 依赖注入(照抄 AnalyticsStore 模式) */
export interface BrandStoreDeps {
  load?: () => BrandKitConfig;
  persist?: (config: BrandKitConfig) => void;
}

/** 默认持久化文件路径(userData/brand-kit/brand.json) */
function brandFile(): string {
  const dir = join(app.getPath('userData'), 'brand-kit');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'brand.json');
}

/** 默认加载实现 */
function defaultLoad(): BrandKitConfig {
  try {
    const fp = brandFile();
    if (!existsSync(fp)) return {};
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as BrandKitConfig) : {};
  } catch (err) {
    logger.error(`[brand-kit] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** 默认持久化实现 */
function defaultPersist(config: BrandKitConfig): void {
  try {
    const fp = brandFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[brand-kit] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 品牌配置存储
 * 内存缓存 + 每次变更即落盘;load/persist 可注入
 */
export class BrandStore {
  private config: BrandKitConfig = {};
  private readonly loadFn: () => BrandKitConfig;
  private readonly persistFn: (config: BrandKitConfig) => void;
  private loaded = false;

  constructor(deps: BrandStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = this.loadFn();
    this.config = stored && typeof stored === 'object' ? stored : {};
    this.loaded = true;
  }

  private flush(): void {
    this.persistFn(this.config);
  }

  /** 读取品牌配置 */
  getConfig(): BrandKitConfig {
    this.ensureLoaded();
    return { ...this.config, filter: this.config.filter ? { ...this.config.filter } : undefined };
  }

  /**
   * 更新品牌配置(浅合并,未传字段保持不变)
   * @param patch 配置片段
   * @returns 合并后的完整配置
   */
  setConfig(patch: Partial<BrandKitConfig>): BrandKitConfig {
    this.ensureLoaded();
    this.config = { ...this.config, ...patch };
    this.flush();
    return this.getConfig();
  }
}

/**
 * 判断品牌配置是否包含画面级视觉项(滤镜/比例;水印与片头片尾单独判断)
 * 纯函数
 */
export function hasBrandVisuals(config: BrandKitConfig | null | undefined): boolean {
  if (!config) return false;
  const hasFilter =
    !!config.filter &&
    Object.values(config.filter).some((v) => typeof v === 'number' && Number.isFinite(v));
  return hasFilter || config.aspect === '9:16' || config.aspect === '16:9';
}

/**
 * 把品牌配置编译为 ffmpeg -vf 滤镜链(纯函数)
 * 顺序:eq 色感 → scale+pad 目标比例(先缩放保持比例,再居中补边)
 * @param config 品牌配置
 * @returns 滤镜链字符串;无画面级配置返回空串
 */
export function buildBrandFilter(config: BrandKitConfig | null | undefined): string {
  if (!config || !hasBrandVisuals(config)) return '';
  const parts: string[] = [];

  if (config.filter) {
    const { brightness, contrast, saturation } = config.filter;
    const eqParts: string[] = [];
    if (typeof brightness === 'number' && Number.isFinite(brightness)) {
      eqParts.push(`brightness=${Math.max(-1, Math.min(1, brightness))}`);
    }
    if (typeof contrast === 'number' && Number.isFinite(contrast)) {
      eqParts.push(`contrast=${Math.max(0, Math.min(2, contrast))}`);
    }
    if (typeof saturation === 'number' && Number.isFinite(saturation)) {
      eqParts.push(`saturation=${Math.max(0, Math.min(2, saturation))}`);
    }
    if (eqParts.length > 0) parts.push(`eq=${eqParts.join(':')}`);
  }

  if (config.aspect === '9:16' || config.aspect === '16:9') {
    const [w, h] = ASPECT_SIZES[config.aspect];
    parts.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
    parts.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);
  }

  return parts.join(',');
}

/** 品牌配置存储单例 */
export const brandStore = new BrandStore();
