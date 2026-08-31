/**
 * AI 切片服务类型定义
 *
 * 职责:声明 AI 切片模块对外/对内的所有数据结构,包括:
 *   - 输入参数(AiSliceParams):视频路径、分辨率、时长阈值、精彩度阈值、水印等
 *   - 输出结果(AiSliceResult / SliceClip):切片列表与单个切片信息
 *   - 分析中间结构(AnalyzedShot / AnalyzeOptions):镜头评分与评分参数
 *
 * 设计约定:
 *   - 复用 common 类型:ResolutionPreset / WatermarkConfig
 *   - 复用 shot-detect 类型:Shot
 *   - 评分归一化到 0-1,阈值过滤在 analyze 阶段完成
 */
import type { ResolutionPreset, WatermarkConfig } from '@shared/types';
import type { Shot } from '../shot-detect';

/** AI 切片参数(渲染层 → 主进程 → 服务) */
export interface AiSliceParams {
  /** 输入长视频路径 */
  videoPath: string;
  /** 分辨率预设 */
  resolution: ResolutionPreset;
  /** 是否保留原画质(为 true 时不做 scale) */
  keepOriginalQuality: boolean;
  /** 最小片段时长(秒),默认 8 */
  minClipDuration?: number;
  /** 最大片段时长(秒),默认 30 */
  maxClipDuration?: number;
  /** 精彩度阈值(0-1),默认 0.5 */
  excitementThreshold?: number;
  /** 输出片段数量(0=不限,输出所有达标片段) */
  maxClipCount?: number;
  /** 水印配置(为 null 或 enabled=false 则不应用) */
  watermark?: WatermarkConfig | null;
  /** 输出目录(空则使用默认导出目录) */
  outputDir?: string;
  /** 输出文件名前缀(默认 'clip') */
  outputPrefix?: string;
}

/** 单个切片结果 */
export interface SliceClip {
  /** 切片索引(从 1 开始) */
  index: number;
  /** 输出文件绝对路径 */
  outputPath: string;
  /** 起始时间(秒) */
  startTime: number;
  /** 结束时间(秒) */
  endTime: number;
  /** 时长(秒) */
  duration: number;
  /** 精彩度评分(0-1) */
  excitementScore: number;
  /** 爆款评分报告(智能评分后填充) */
  virality?: ViralityReport;
}

/** 爆款评分五维子分(0-100) */
export interface ViralitySubScores {
  /** 钩子强度:前 3 秒留人能力 */
  hook: number;
  /** 情绪强度:情绪曲线峰值与张力 */
  emotion: number;
  /** 话题性:热点/共鸣/争议 */
  topic: number;
  /** 完播潜力:节奏、信息密度、时长适配 */
  retention: number;
  /** 标题潜力:可提炼吸睛标题的素材度 */
  titleability: number;
}

/** 爆款评分等级 */
export type ViralityGrade = 'S' | 'A' | 'B' | 'C';

/** 爆款评分报告(PRD-爆款评分与智能分发 FR-1) */
export interface ViralityReport {
  /** 综合爆款分(0-100) */
  score: number;
  /** 等级:S>=85 / A>=70 / B>=55 / C<55 */
  grade: ViralityGrade;
  /** 五维子分(0-100) */
  sub: ViralitySubScores;
  /** 评分理由(1-3 条) */
  reasons: string[];
  /** 改进建议(0-2 条) */
  suggestions: string[];
  /** 候选标题(最多 5 条) */
  titles: string[];
  /** 话题标签(最多 8 条) */
  tags: string[];
  /** 封面文案(最多 3 条) */
  coverText: string[];
  /** 评分来源:llm=智能评分 / heuristic=基础评分(降级) */
  source: 'llm' | 'heuristic';
}

/** AI 切片结果 */
export interface AiSliceResult {
  /** 切片列表(按精彩度降序) */
  clips: SliceClip[];
  /** 切片总数 */
  totalClips: number;
}

/** 精彩度分析参数(传入 analyzeShots) */
export interface AnalyzeOptions {
  /** 最小片段时长(秒) */
  minClipDuration: number;
  /** 最大片段时长(秒) */
  maxClipDuration: number;
  /** 精彩度阈值(0-1) */
  excitementThreshold: number;
}

/** 单个镜头评分结果(analyzer → slicer 传递) */
export interface AnalyzedShot {
  /** 原始镜头信息 */
  shot: Shot;
  /** 综合精彩度评分(0-1) */
  score: number;
}
