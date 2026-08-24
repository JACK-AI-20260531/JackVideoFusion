/**
 * 节奏提取编排单测
 * 职责:通过注入 mock 镜头检测,验证 extractRhythm 的路径校验、统计、checkpoint
 * 说明:不依赖真实 shotDetectService(内部 spawn ffprobe)
 * 运行:npm run test 或 node --test --import tsx src/main/services/film-dub-clone/__tests__/rhythm-extractor.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRhythm, type ExtractRhythmDeps } from '../rhythm-extractor.ts';
import type { TaskQueue, Checkpoint } from '../../task-queue/types';
import type { Shot } from '../../shot-detect';
import { CancelToken } from '../../ffmpeg/types';

function shots(...times: Array<[number, number]>): Shot[] {
  return times.map(([start, end], i) => ({
    index: i,
    startTime: start,
    endTime: end,
    duration: end - start,
    score: 0.5,
  }));
}

function makeQueue() {
  const checkpoints: Checkpoint[] = [];
  const queue = {
    loadCheckpoint: () => null,
    saveCheckpoint: (taskId: string, step: string, progress: number, context: unknown) => {
      checkpoints.push({ taskId, step, progress, context, savedAt: '' });
    },
  } as unknown as TaskQueue;
  return { queue, checkpoints };
}

const token = new CancelToken('t');

describe('extractRhythm 校验', () => {
  it('参考视频路径为空时抛错', async () => {
    const { queue } = makeQueue();
    await assert.rejects(
      () => extractRhythm('', queue, 't1', token, { detect: async () => ({ shots: [], totalDuration: 0, shotCount: 0 }) }),
      /参考视频路径为空/,
    );
  });

  it('已取消令牌直接抛取消错误', async () => {
    const { queue } = makeQueue();
    const cancelled = new CancelToken('t');
    cancelled.cancel('stop');
    await assert.rejects(
      () => extractRhythm('/ref.mp4', queue, 't1', cancelled),
      /已取消/,
    );
  });

  it('未检测到任何镜头时抛错', async () => {
    const { queue } = makeQueue();
    await assert.rejects(
      () => extractRhythm('/ref.mp4', queue, 't1', token, { detect: async () => ({ shots: [], totalDuration: 0, shotCount: 0 }) }),
      /未检测到任何镜头/,
    );
  });
});

describe('extractRhythm 正常流程', () => {
  it('返回正确的节奏统计并落 checkpoint', async () => {
    const { queue, checkpoints } = makeQueue();
    const deps: ExtractRhythmDeps = {
      detect: async () => ({
        shots: shots([0, 5], [5, 15]), // 2 镜头:5s, 10s → 平均 7.5
        totalDuration: 15,
        shotCount: 2,
      }),
    };
    const rhythm = await extractRhythm('/ref.mp4', queue, 't1', token, deps);
    assert.equal(rhythm.referenceVideoPath, '/ref.mp4');
    assert.equal(rhythm.shots.length, 2);
    assert.equal(rhythm.totalDuration, 15);
    assert.equal(rhythm.cutCount, 1);
    assert.equal(rhythm.avgShotDuration, 7.5);
    // checkpoint
    assert.ok(checkpoints.some((c) => c.step === 'film-dub-rhythm'));
  });
});
