/**
 * 流水线运行器(PRD-v2.1 FR-2)
 * 职责:按 steps 串行执行注入的 StepExecutor,产物链式传递
 *       任一步失败即停,后续标 blocked;支持取消(标记 cancelled)
 * 设计要点:
 *  - 纯编排:执行器、进度回调、状态回调全部注入,可 node:test 单测
 *  - 步骤失败把错误写进 run.stepErrors[i],run.error 为首个失败信息
 *  - 取消识别:FFmpegError(CANCELLED) 或 token 已取消
 */
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { PipelineRunState, PipelineStep, PipelineStepType, StepRunStatus } from './types';

/** 步骤执行上下文 */
export interface StepContext {
  /** 关联的流水线任务 ID(task-queue) */
  taskId: string;
  /** 上一步产物;首步为 null */
  prevArtifact: string | null;
  /** 取消令牌(与流水线任务一致) */
  token: CancelToken;
  /** 步骤内进度(0-100,外层按步数折算) */
  onStepProgress: (p: number) => void;
}

/** 步骤执行器:返回产物路径(文件/目录);无产物返回 null */
export type StepExecutor = (step: PipelineStep, ctx: StepContext) => Promise<string | null>;

/** 执行器映射(按步骤类型) */
export type StepExecutors = Partial<Record<PipelineStepType, StepExecutor>>;

/** runPipeline 依赖(执行器 + 进度/状态回调) */
export interface RunPipelineDeps {
  /** 按步骤类型映射的执行器 */
  executors: StepExecutors;
  /** 整体进度(0-100) */
  onProgress?: (p: number) => void;
  /** 运行状态变化钩子(持久化用) */
  onRunUpdate?: (run: PipelineRunState) => void;
}

/**
 * 串行执行流水线步骤
 * @param steps 步骤数组
 * @param deps 执行器与回调
 * @param token 取消令牌(与流水线任务一致)
 * @param taskId 关联的 task-queue 任务 ID
 * @returns 最终运行状态(含每步状态/错误/产物)
 */
export async function runPipeline(
  steps: PipelineStep[],
  deps: RunPipelineDeps,
  token: CancelToken,
  taskId: string = 'pipeline',
): Promise<PipelineRunState> {
  const run: PipelineRunState = {
    startedAt: new Date().toISOString(),
    status: 'running',
    stepStatuses: steps.map(() => 'pending' as StepRunStatus),
    stepErrors: steps.map(() => undefined),
    artifacts: steps.map(() => null),
  };
  const emit = () => deps.onRunUpdate?.(run);

  /** 标记下标之后全部 blocked(失败/取消时) */
  const blockRest = (from: number) => {
    for (let j = from + 1; j < steps.length; j++) run.stepStatuses[j] = 'blocked';
  };

  let prev: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const exec = deps.executors[steps[i].type];
    if (!exec) {
      run.stepStatuses[i] = 'failed';
      run.stepErrors![i] = `步骤 ${i + 1} 无 ${steps[i].type} 执行器`;
      run.error = run.stepErrors![i];
      run.status = 'failed';
      blockRest(i);
      emit();
      return run;
    }
    run.stepStatuses[i] = 'running';
    emit();
    try {
      const artifact = await exec(steps[i], {
        taskId,
        prevArtifact: prev,
        token,
        onStepProgress: (p) => deps.onProgress?.(Math.round(((i + p) / steps.length) * 100)),
      });
      run.artifacts![i] = artifact;
      prev = artifact;
      run.stepStatuses[i] = 'done';
      deps.onProgress?.(Math.round(((i + 1) / steps.length) * 100));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.stepErrors![i] = msg;
      const isCancelled = (err instanceof FFmpegError && err.code === 'CANCELLED') || token.cancelled;
      run.stepStatuses[i] = isCancelled ? 'cancelled' : 'failed';
      run.status = isCancelled ? 'cancelled' : 'failed';
      if (!isCancelled) run.error = `步骤 ${i + 1} 失败: ${msg}`;
      blockRest(i);
      emit();
      return run;
    }
    emit();
  }

  if (run.status === 'running') run.status = 'done';
  run.finishedAt = new Date().toISOString();
  emit();
  return run;
}

/** CancelToken 类型重导出(执行器签名引用用) */
export type { CancelToken };
