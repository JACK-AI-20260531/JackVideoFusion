/**
 * 自动流水线服务单例(PRD-v2.1 FR-2/3)
 * 职责:组装默认步骤执行器(ffmpeg 分割/随机混剪/自动发布)+ 运行编排 + 定时调度
 * 设计要点:
 *  - 管线运行 = 一个 taskQueue 任务(type='pipeline'),整体进度 = 完成步数/总步数
 *  - 步骤执行器复用现有服务:ffmpegService.split / videoMixService.runMix / publishQueue.enqueue
 *  - 三结局:done→complete、失败→fail、取消→fail(error 已带原因)
 */
import { taskQueue } from '../task-queue';
import type { TaskItem } from '../task-queue/types';
import { ffmpegService } from '../ffmpeg';
import { CancelToken } from '../ffmpeg/types';
import { videoMixService } from '../video-mix';
import { publishQueue } from '../auto-publish/publish-queue';
import type { PublishParams, PublishTask } from '../auto-publish/types';
import { logger } from '../../utils/logger';
import { pipelineStore } from './store';
import { runPipeline } from './runner';
import { isPipelineDue } from './scheduler';
import type {
  AutoPublishStepParams,
  MaterialSplitStepParams,
  Pipeline,
  PipelineStep,
  PipelineRunState,
  VideoMixStepParams,
} from './types';
import type { StepContext } from './runner';

/** 活跃流水线任务的取消令牌:taskId → CancelToken */
const activeTokens = new Map<string, CancelToken>();

/** 素材分割执行器:逐文件调用 ffmpegService.split,产物为输出目录 */
async function runMaterialSplit(step: PipelineStep, ctx: StepContext): Promise<string | null> {
  const p = step.params as unknown as MaterialSplitStepParams;
  for (let i = 0; i < p.files.length; i++) {
    const segs = await ffmpegService.split(p.files[i], p.segmentSec, p.outputDir, {}, ctx.token);
    logger.info(`[pipeline] 分割 ${i + 1}/${p.files.length} 完成,产出 ${segs.length} 段`);
    ctx.onStepProgress(Math.round(((i + 1) / p.files.length) * 100));
  }
  return p.outputDir;
}

/** 随机混剪执行器:复用 videoMixService.runMix,产物为输出文件 */
async function runVideoMix(step: PipelineStep, ctx: StepContext): Promise<string | null> {
  const p = (step.params as unknown as VideoMixStepParams).params;
  const result = await videoMixService.runMix(
    { ...p, outputName: p.outputName || `pipeline-${Date.now()}.mp4` },
    ctx.taskId,
    ctx.token,
  );
  return result.outputPath;
}

/** 自动发布执行器:videoPath 为空时自动接上一步产物;入队后立即返回(执行由发布串行链接管) */
function runAutoPublish(step: PipelineStep, ctx: StepContext): Promise<string | null> {
  const p = step.params as unknown as AutoPublishStepParams;
  const videoPath = p.usePrevArtifact && ctx.prevArtifact ? ctx.prevArtifact : p.params.videoPath;
  const params: PublishParams = { ...p.params, videoPath };
  const task: PublishTask = {
    id: `publish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
    params,
  };
  publishQueue.enqueue(task);
  return Promise.resolve(null);
  publishQueue.enqueue(task);
  return Promise.resolve(null);
}

/** 三类步骤参数的运行时结构(与 types.ts 对齐) */
type MaterialSplitParams = { files: string[]; segmentSec: number; outputDir: string };
type VideoMixParams = { params: Parameters<typeof videoMixService.runMix>[0] };
type AutoPublishParams = {
  params: PublishParams;
  usePrevArtifact?: boolean;
};

/**
 * 执行单条流水线:入队 taskQueue + 串行跑步骤 + 三结局处理
 * @returns 最终运行状态
 */
export async function executePipeline(pipeline: Pipeline): Promise<PipelineRunState> {
  const taskId = `pipeline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const task: TaskItem = {
    id: taskId,
    type: 'pipeline',
    title: `流水线:${pipeline.name}`,
    status: 'pending',
    progress: 0,
    params: { pipelineId: pipeline.id } as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
  taskQueue.enqueue(task);

  const token = new CancelToken(taskId);
  activeTokens.set(taskId, token);

  const run = await runPipeline(
    pipeline.steps,
    {
      executors: {
        'material-split': runMaterialSplit,
        'video-mix-random': runVideoMix,
        'auto-publish': runAutoPublish,
      },
      onProgress: (p) => taskQueue.updateProgress(taskId, p),
      onRunUpdate: (r) => void pipelineStore.setRun(pipeline.id, r),
    },
    token,
    taskId,
  );

  activeTokens.delete(taskId);
  if (run.status === 'done') {
    taskQueue.complete(taskId);
  } else {
    taskQueue.fail(taskId, run.error ?? `流水线${run.status}`);
  }

  pipelineStore.setRun(pipeline.id, run);
  logger.info(`[pipeline] 「${pipeline.name}」执行结束: ${run.status}`);
  return run;
}

/** 手动取消运行中的流水线任务 */
export function cancelPipelineRun(taskId: string): void {
  const token = activeTokens.get(taskId);
  if (token) {
    token.cancel('用户取消流水线');
    activeTokens.delete(taskId);
  }
  taskQueue.cancel(taskId);
}

/** 流水线定时调度器:轮询到期管线并执行 */
export class PipelineSchedulerService {
  private timer: NodeJS.Timeout | null = null;

  /** 启动轮询(幂等) */
  start(checkIntervalMs = 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const p of pipelineStore.list()) {
        if (!p.schedule || !p.scheduleEnabled) continue;
        if (!isPipelineDue(p.schedule, p.lastRunAt, now)) continue;
        void executePipeline(p).catch((err) =>
          logger.error(
            `[pipeline] 定时执行失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }, checkIntervalMs);
    this.timer.unref?.();
  }
}

/** 全局定时调度器单例 */
export const pipelineScheduler = new PipelineSchedulerService();
