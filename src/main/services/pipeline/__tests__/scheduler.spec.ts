/**
 * 流水线定时调度单测(PRD-v2.1 FR-3)
 * 运行:node --test --import tsx src/main/services/pipeline/__tests__/scheduler.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPipelineDue, PipelineScheduler } from '../scheduler';
import type { Pipeline, PipelineSchedule } from '../types';

const daily08: PipelineSchedule = { kind: 'daily', at: '08:00' };

describe('isPipelineDue', () => {
  test('daily:当天 08:00 后且今天未跑过 → due', () => {
    // 2026-01-05 09:00 本地时间(周一)
    const now = new Date(2026, 0, 5, 9, 0).getTime();
    assert.equal(isPipelineDue(daily08, undefined, now), true);
    assert.equal(isPipelineDue(daily08, new Date(2026, 0, 5, 7, 0).toISOString(), now), true);
    assert.equal(isPipelineDue(daily08, new Date(2026, 0, 5, 8, 30).toISOString(), now), false);
  });

  test('weekly:weekday 不匹配不触发', () => {
    const s: PipelineSchedule = { kind: 'weekly', at: '08:00', weekday: 1 };
    const now = new Date(2026, 0, 5, 9, 0).getTime(); // 周一
    assert.equal(isPipelineDue(s, undefined, now), true);
    assert.equal(isPipelineDue({ ...s, weekday: 2 }, undefined, now), false);
  });

  test('once:从未跑过才触发', () => {
    const s: PipelineSchedule = { kind: 'once', at: '08:00' };
    const now = new Date(2026, 0, 5, 9, 0).getTime();
    assert.equal(isPipelineDue(s, undefined, now), true);
    assert.equal(isPipelineDue(s, new Date(2026, 0, 5, 8, 30).toISOString(), now), false);
  });

  test('非法 at 永不触发', () => {
    assert.equal(isPipelineDue({ kind: 'daily', at: 'xx' }, undefined, Date.now()), false);
  });
});

describe('PipelineScheduler', () => {
  test('runOnce 只触发到期且启用的管线', async () => {
    const fired: string[] = [];
    const mk = (
      id: string,
      schedule?: PipelineSchedule,
      scheduleEnabled?: boolean,
    ): Pipeline => ({
      id,
      name: id,
      steps: [],
      schedule,
      scheduleEnabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const pipelines = [mk('p1', daily08, true), mk('p2', daily08, false), mk('p3')];
    const scheduler = new PipelineScheduler({
      store: { list: () => pipelines, setRun: () => true },
      runner: (p) => {
        fired.push(p.id);
        return Promise.resolve();
      },
      checkIntervalMs: 1,
    });
    const ran = await scheduler.runOnce(new Date(2026, 0, 5, 9, 0).getTime());
    assert.equal(ran, 1);
    assert.deepEqual(fired, ['p1']);
  });
});
