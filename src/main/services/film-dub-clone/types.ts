/**
 * 影视解说克隆服务类型定义
 *
 * 职责:声明影视解说克隆模块对外/对内的所有数据结构,包括:
 *   - 输入参数(CloneParams):参考视频、素材文件夹、文案、分辨率、配音、水印、字幕等
 *   - 节奏特征(RhythmPattern):参考视频的镜头序列与节奏统计量
 *   - 匹配结果(ShotMatch):参考镜头与自有素材帧的对应关系
 *   - 输出结果(CloneResult):成片路径、时长、片段数、节奏特征回传
 *
 * 设计约定:
 *   - 单文件夹隔离:folderId 必填,素材匹配只在单文件夹内操作
 *   - 节奏复刻:输出片段数 = 参考镜头数,每段时长 = 对应参考镜头时长
 *   - 复用 common 类型:ResolutionPreset / WatermarkConfig / SubtitleStyleConfig
 *   - RhythmPattern 携带 referenceVideoPath:matcher 需据此抽取参考镜头中间帧做视觉匹配
 */
import type { Shot } from '../shot-detect';
import type {
  ResolutionPreset,
  WatermarkConfig,
  SubtitleStyleConfig,
} from '@shared/types';

/** 影视解说克隆参数(渲染层 → 主进程 → 服务) */
export interface CloneParams {
  /** 参考视频路径(提取镜头节奏) */
  referenceVideoPath: string;
  /** 自有素材文件夹 ID(替换画面来源,单文件夹隔离) */
  folderId: string;
  /** 解说文案 */
  script: string;
  /** 分辨率预设 */
  resolution: ResolutionPreset;
  /** 是否保留原画质(为 true 时不做 scale) */
  keepOriginalQuality: boolean;
  /** 是否生成配音(TTS) */
  generateTts: boolean;
  /** TTS 语音短名(如 zh-CN-XiaoxiaoNeural),generateTts=true 时生效 */
  ttsVoice?: string;
  /** 片段间转场淡化时长(秒),0 或省略=硬切;>0 启用 xfade 链式转场 */
  transitionSec?: number;
  /** 水印配置(为 null 或 enabled=false 则不应用) */
  watermark?: WatermarkConfig | null;
  /** 字幕配置(用文案作为字幕内容) */
  subtitle?: { enabled: boolean; style?: SubtitleStyleConfig } | null;
  /** 输出目录(空则使用默认导出目录) */
  outputDir?: string;
  /** 输出文件名(空则自动命名) */
  outputName?: string;
}

/**
 * 节奏特征
 * 描述参考视频的镜头节奏,作为画面替换与片段时长分配的依据
 */
export interface RhythmPattern {
  /** 参考视频路径(matcher 据此抽取参考镜头中间帧) */
  referenceVideoPath: string;
  /** 参考视频镜头序列(已按时间排序) */
  shots: Shot[];
  /** 平均镜头时长(秒) */
  avgShotDuration: number;
  /** 参考视频总时长(秒) */
  totalDuration: number;
  /** 剪辑点数(镜头数 - 1) */
  cutCount: number;
}

/**
 * 单条镜头匹配结果
 * 描述参考视频某镜头与自有素材某帧的对应关系,作为节奏复刻的输入单元
 */
export interface ShotMatch {
  /** 参考视频镜头节点(含起止时间与时长) */
  shot: Shot;
  /** 匹配到的自有素材视频文件绝对路径 */
  materialPath: string;
  /** 匹配到的自有素材帧时间点(秒,作为切片起点候选) */
  timeSec: number;
}

/** 影视解说克隆结果 */
export interface CloneResult {
  /** 成片绝对路径 */
  outputPath: string;
  /** 成片时长(秒) */
  durationSec: number;
  /** 匹配片段数(等于参考镜头数) */
  segmentCount: number;
  /** 复刻所用的节奏特征(回传供调试/展示) */
  rhythm: RhythmPattern;
}
