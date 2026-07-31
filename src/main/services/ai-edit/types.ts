/**
 * AI 剪辑服务类型定义
 *
 * 职责:声明 AI 剪辑模块对外/对内的所有数据结构,包括:
 *   - 输入参数(AiEditParams):文案、文件夹、分辨率、配音、水印、字幕等
 *   - 输出结果(AiEditResult):成片路径、时长、片段数、关键词列表
 *   - 语义匹配中间结构(SceneMatch):文案段落与画面帧的匹配结果
 *
 * 设计约定:
 *   - 单文件夹隔离:folderId 必填,语义匹配只在单文件夹内操作素材
 *   - 文案驱动:文案分段后,每段匹配一帧画面,串接成片段序列
 *   - 复用 common 类型:ResolutionPreset / WatermarkConfig / SubtitleStyleConfig
 */
import type {
  ResolutionPreset,
  WatermarkConfig,
  SubtitleStyleConfig,
} from '@shared/types';

/** AI 剪辑参数(渲染层 → 主进程 → 服务) */
export interface AiEditParams {
  /** 文案(解说词,按句号/换行分段匹配画面) */
  script: string;
  /** 素材文件夹 ID(单文件夹隔离) */
  folderId: string;
  /** 分辨率预设 */
  resolution: ResolutionPreset;
  /** 是否保留原画质(为 true 时不做 scale) */
  keepOriginalQuality: boolean;
  /** 是否生成配音(TTS) */
  generateTts: boolean;
  /** TTS 语音短名(如 zh-CN-XiaoxiaoNeural),generateTts=true 时生效 */
  ttsVoice?: string;
  /** 水印配置(为 null 或 enabled=false 则不应用) */
  watermark?: WatermarkConfig | null;
  /** 字幕配置(用文案作为字幕内容) */
  subtitle?: { enabled: boolean; style?: SubtitleStyleConfig } | null;
  /** 输出目录(空则使用默认导出目录) */
  outputDir?: string;
  /** 输出文件名(空则自动命名) */
  outputName?: string;
}

/** AI 剪辑结果 */
export interface AiEditResult {
  /** 成片绝对路径 */
  outputPath: string;
  /** 成片时长(秒) */
  durationSec: number;
  /** 匹配片段数 */
  segmentCount: number;
  /** 抽取出的关键词列表 */
  keywords: string[];
}

/**
 * 单条场景匹配结果
 * 描述文案中某段落与某视频帧的对应关系,作为成片合成的输入单元
 */
export interface SceneMatch {
  /** 文案段落原文(用于驱动字幕/配音对齐) */
  paragraph: string;
  /** 该段落对应的关键词(用于排序/调试) */
  keyword: string;
  /** 匹配到的视频文件绝对路径 */
  videoPath: string;
  /** 匹配到的视频帧时间点(秒) */
  timeSec: number;
  /** 该段切出的片段时长(秒,默认 3s,可被配音时长覆盖) */
  segmentSec: number;
  /** 余弦相似度分数 [-1, 1],用于调试与降序展示 */
  score: number;
}

/** 关键词预览响应(extractKeywords IPC 返回) */
export interface KeywordPreview {
  /** 抽取出的关键词列表 */
  keywords: string[];
  /** LLM 原始输出(调试用) */
  raw: string;
}
