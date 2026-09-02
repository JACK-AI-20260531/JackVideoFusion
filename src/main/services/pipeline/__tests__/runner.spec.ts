/**
 * 流水线运行器单测:串行、产物链、失败即停、取消、进度(PRD-v2.1 FR-2)
 * 运行:node --test --import tsx src/main/services/pipeline/__tests__/runner.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../runner';
import type { PipelineStep } from '../types';
import { CancelToken } from '../../ffmpeg/types';

/** 构造 n 个 video-mix-random 占位步骤 */
function steps(n: number): PipelineStep[] {
  return Array.from({ length: n }, () => ({ type: 'video-mix-random', params: {} }));
}

test('串行执行并链式传递产物', async () => {
  const seen: (string | null)[] = [];
  const exec = async (_step: PipelineStep, ctx) => {
    seen.push(ctx.prevArtifact);
    return `out-${seen.length}`;
  };
  const run = await runPipeline(
    steps(3),
    { executors: { 'video-mix-random': exec } },
    new CancelToken('t'),
  );
  assert.equal(run.status, 'done');
  assert.deepEqual(seen, [null, 'out-1', 'out-2']);
  assert.deepEqual(run.stepStatuses, ['done', 'done', 'done']);
  assert.deepEqual(run.artifacts, ['out-1', 'out-2', 'out-3']);
});

test('第 2 步失败:标记 failed + 后续 blocked,返回 failed', async () => {
  const exec = async (_step: PipelineStep, ctx: { prevArtifact: string | null }) => {
    if (ctx.prevArtifact === null) return 'artifact-1';
    throw new Error('boom');
  };
  const run = await runPipeline(
    steps(3),
    { executors: { 'video-mix-random': exec } },
    new CancelToken('t'),
  );
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.stepStatuses, ['done', 'failed', 'blocked']);
  assert.equal(run.error, '步骤 2 失败: boom');
  assert.equal(run.stepErrors?.[1], 'boom');
});

test('整体进度回调最终到 100', async () => {
  const exec = async () => 'out';
  const progressList: number[] = [];
  await runPipeline(
    steps(2),
    { executors: { 'video-mix-random': exec }, onProgress: (p) => progressList.push(p) },
    new CancelToken('t'),
  );
  assert.equal(progressList[progressList.length - 1], 100);
});

test('token 取消:当前步 cancelled,后续 blocked,状态 cancelled', async () => {
  const token = new CancelToken('t');
  const exec = async (_s: PipelineStep, ctx) => {
    token.cancel('用户取消');
    ctx.onStepProgress(10);
    throw new Error('CANCELLED');
  };
  const run = await runPipeline(steps(2), { executors: { 'video-mix-random': exec } }, token);
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(run.stepStatuses, ['cancelled', 'blocked']);
});

test('onRunUpdate 逐步通知(持久化钩子)', async () => {
  const runs: string[] = [];
  const exec = async () => 'o';
  await runPipeline(steps(2), {
    executors: { 'video-mix-random': exec },
    onRunUpdate: (r) => runs.push(r.status),
  });
  // 每步至少通知一次 running,最终以终态结束
  assert.ok(runs.length >= 2);
  assert.equal(runs[runs.length - 1], 'done');
});
