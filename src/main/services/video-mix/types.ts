/**
 * 视频混剪服务 - 类型定义
 * 职责:声明混剪模式、参数结构、结果结构,供主进程服务与 IPC 层共享
 *
 * 设计要点:
 *  - 两种模式:random(随机素材混剪) / audio-match(文件夹音频匹配)
 *  - 模式二严格遵循文件夹隔离:每个 folderId 独立产出一个片段
 *  - 字段使用 shared/types.ts 中的通用配置类型(WatermarkConfig/SubtitleStyleConfig/ResolutionPreset)
 */
import type {
  ResolutionPreset,
  WatermarkConfig,
  SubtitleStyleConfig,
} from '@shared/types';

/**
 * 混剪模式
 * - random: 随机素材混剪,从多文件夹各抽取片段拼接
 * - audio-match: 文件夹音频匹配,每个文件夹独立用其音频+视频合成为一个片段
 */
export type MixMode = 'random' | 'audio-match';

/**
 * 通用混剪参数
 * 两种模式共用此结构,根据 mode 解读不同字段
 */
export interface MixParams {
  /** 混剪模式 */
  mode: MixMode;
  /**
   * 参与的文件夹 ID 列表
   * 模式一:多文件夹按顺序,每文件夹抽 N 条片段
   * 模式二:每文件夹独立产出一个片段,最后再拼接
   */
  folderIds: string[];
  /** 模式一:每个文件夹抽取的片段数;模式二:每文件夹抽取的视频条数(默认 3) */
  perFolderCount?: number;
  /**
   * 显式素材路径清单(PRD-v2.2 FR-4,语义选材接入)
   * 非空时走"清单模式":逐条直接参与混剪,跳过文件夹随机抽取,
   * folderIds/perFolderCount 校验豁免;为空时行为不变
   */
  materialPaths?: string[];
  /** 模式一:目标总时长(秒),0 表示不限 */
  targetDurationSec?: number;
  /** 模式一:是否不重复复用素材(unique 模式) */
  uniqueReuse?: boolean;
  /** 防撞车:跳过近 7 天(复用间隔窗口)内已使用的素材(PRD-v1.7 FR-5) */
  skipRecentUsed?: boolean;
  /** 应用品牌套件(水印/片头片尾/统一滤镜/目标比例,取全局品牌配置;PRD-v1.7 FR-7) */
  brandKit?: boolean;
  /** 单片段时长(秒),用于把长视频切成短片段后再拼接;0 表示不切分 */
  segmentSec?: number;
  /** 分辨率预设 */
  resolution: ResolutionPreset;
  /** 是否保留原画质(为 true 时不做 scale) */
  keepOriginalQuality: boolean;
  /** 水印配置(可选,null/undefined=不加水印) */
  watermark?: WatermarkConfig | null;
  /** 字幕配置(可选,null/undefined=不烧字幕) */
  subtitle?: { srtPath: string; style?: SubtitleStyleConfig } | null;
  /** 模式二:是否去除原视频声音 */
  stripOriginalAudio?: boolean;
  /** 模式二:背景音乐淡入淡出(秒),0=无淡入淡出 */
  audioFadeSec?: number;
  /** 模式二:音频是否循环适配视频时长 */
  audioLoop?: boolean;
  /** 转场淡化(秒),0=无转场;>0 时在 random 模式 concat 阶段启用 xfade 链式转场 */
  transitionSec?: number;
  /** 输出目录(空则用默认 userData/exports) */
  outputDir?: string;
  /** 输出文件名(不含路径) */
  outputName?: string;
}

/**
 * 混剪结果
 */
export interface MixResult {
  /** 最终输出文件绝对路径 */
  outputPath: string;
  /** 最终视频时长(秒) */
  durationSec: number;
  /** 拼接片段数量 */
  segmentCount: number;
}
