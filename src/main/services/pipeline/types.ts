/**
 * 自动流水线服务 - 类型定义(PRD-v2.1 FR-2/3)
 * 职责:管线、步骤、定时、运行态结构与三类全自动步骤参数
 */
import type { MixParams } from '../video-mix/types';
import type { PublishParams } from '../auto-publish/types';

/** 全自动步骤类型池(人工步骤不进链,完成后由 UI 给"建议下一步") */
export type PipelineStepType = 'material-split' | 'video-mix-random' | 'auto-publish';

/** 步骤运行状态 */
export type StepRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

/** 单个步骤 */
export interface PipelineStep {
  type: PipelineStepType;
  params: Record<string, unknown>;
}

/** 定时配置 */
export interface PipelineSchedule {
  kind: 'daily' | 'weekly' | 'once';
  /** 'HH:mm'(本地时间) */
  at: string;
  /** 0-6(0=周日),weekly 必填 */
  weekday?: number;
}

/** 管线运行状态(持久化到 lastRun) */
export interface PipelineRunState {
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  stepStatuses: StepRunStatus[];
  stepErrors?: (string | undefined)[];
  /** 每步产物(文件/目录),与 steps 一一对应 */
  artifacts?: (string | null)[];
  error?: string;
}

/** 管线 */
export interface Pipeline {
  id: string;
  name: string;
  steps: PipelineStep[];
  schedule?: PipelineSchedule;
  scheduleEnabled?: boolean;
  lastRunAt?: string;
  lastRun?: PipelineRunState;
  createdAt: string;
  updatedAt: string;
}

/** 素材分割步骤参数 */
export interface MaterialSplitStepParams {
  /** 待分割视频文件绝对路径列表 */
  files: string[];
  /** 每段时长(秒) */
  segmentSec: number;
  /** 输出目录 */
  outputDir: string;
}

/** 随机混剪步骤参数 */
export interface VideoMixStepParams {
  params: MixParams;
}

/** 自动发布步骤参数(videoPath 为空时自动使用上一步产物) */
export interface AutoPublishStepParams {
  params: PublishParams;
  usePrevArtifact?: boolean;
}
