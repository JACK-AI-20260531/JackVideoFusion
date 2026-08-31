/**
 * 定时发布持久化调度单测
 * 职责:验证 classifySchedule 定时分类、canTransition 状态流转校验、
 *      ScheduleStore CRUD 与持久化(注入内存实现,绕开 electron)
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/schedule-store.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScheduleStore,
  classifySchedule,
  canTransition,
} from '../schedule-store.ts';
import type { ScheduledEntry } from '../schedule-store.ts';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

describe('classifySchedule', () => {
  it('空/非法时间视为立即发布', () => {
    assert.equal(classifySchedule(undefined, NOW), 'immediate');
    assert.equal(classifySchedule('', NOW), 'immediate');
    assert.equal(classifySchedule('not-a-date', NOW), 'immediate');
  });

  it('过去时间为 missed,未来时间为 upcoming', () => {
    assert.equal(classifySchedule('2026-09-01T11:59:59.000Z', NOW), 'missed');
    assert.equal(classifySchedule('2026-09-01T12:00:01.000Z', NOW), 'upcoming');
  });
});

describe('canTransition', () => {
  it('合法流转通过', () => {
    assert.equal(canTransition('pending', 'firing'), true);
    assert.equal(canTransition('pending', 'cancelled'), true);
    assert.equal(canTransition('pending', 'failed'), true);
    assert.equal(canTransition('firing', 'done'), true);
    assert.equal(canTransition('firing', 'failed'), true);
    assert.equal(canTransition('firing', 'cancelled'), true);
  });

  it('非法流转被拒绝', () => {
    assert.equal(canTransition('pending', 'done'), false);
    assert.equal(canTransition('firing', 'pending'), false);
    assert.equal(canTransition('done', 'pending'), false);
    assert.equal(canTransition('failed', 'done'), false);
    assert.equal(canTransition('cancelled', 'pending'), false);
  });
});

/** 构造一个条目 */
function entry(over: Partial<ScheduledEntry> = {}): ScheduledEntry {
  return {
    taskId: 't1',
    platform: 'douyin',
    title: '标题',
    scheduledAt: '2026-09-02T08:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'pending',
    ...over,
  };
}

describe('ScheduleStore CRUD', () => {
  it('upsert 后可查询并按 scheduledAt 升序列出', () => {
    const store = new ScheduleStore({ load: () => [], persist: () => undefined });
    store.upsert(entry({ taskId: 'b', scheduledAt: '2026-09-03T08:00:00.000Z' }));
    store.upsert(entry({ taskId: 'a', scheduledAt: '2026-09-02T08:00:00.000Z' }));
    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].taskId, 'a');
    assert.equal(list[1].taskId, 'b');
  });

  it('markStatus 合法流转更新并持久化,非法流转被拒绝', () => {
    const store = new ScheduleStore({ load: () => [], persist: () => undefined });
    store.upsert(entry({}));
    assert.equal(store.markStatus('t1', 'done'), false); // pending→done 非法
    assert.equal(store.get('t1')?.status, 'pending');
    assert.equal(store.markStatus('t1', 'firing'), true);
    assert.equal(store.markStatus('t1', 'done'), true);
    assert.equal(store.get('t1')?.status, 'done');
    // 终态不可再流转
    assert.equal(store.markStatus('t1', 'pending'), false);
  });

  it('markStatus 带错误信息回写', () => {
    const store = new ScheduleStore({ load: () => [], persist: () => undefined });
    store.upsert(entry());
    store.markStatus('t1', 'failed', '错过定时发布时间');
    assert.equal(store.get('t1')?.error, '错过定时发布时间');
  });

  it('不存在的条目返回 false', () => {
    const store = new ScheduleStore({ load: () => [], persist: () => undefined });
    assert.equal(store.markStatus('nope', 'firing'), false);
    assert.equal(store.get('nope'), null);
  });

  it('懒加载:构造后首次访问读取持久化数据', () => {
    const initial = [entry({ taskId: 'loaded', status: 'pending' })];
    let loadCount = 0;
    const store = new ScheduleStore({
      load: () => {
        loadCount++;
        return initial;
      },
      persist: () => undefined,
    });
    assert.equal(store.get('loaded')?.taskId, 'loaded');
    assert.equal(loadCount, 1);
    // 二次访问不再重复加载
    store.get('loaded');
    assert.equal(loadCount, 1);
  });

  it('变更即持久化', () => {
    let persistCount = 0;
    const store = new ScheduleStore({ load: () => [], persist: () => void persistCount++ });
    store.upsert(entry({ taskId: 't1' }));
    store.markStatus('t1', 'firing');
    store.remove('t1');
    assert.equal(persistCount, 3);
    assert.equal(store.list().length, 0);
  });
});
