/**
 * 任务存储纯逻辑单测
 * 职责:验证 filterAndSortTasks 的按状态/类型过滤与创建时间排序
 * 说明:纯函数;ElectronStoreTaskStore 的持久化方法依赖 electron-store,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/storage/__tests__/task-store.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortTasks } from '../task-store.ts';
import type { TaskRecord, TaskListFilter } from '../types';

function task(id: string, status: string, type: string, createdAt: string): TaskRecord {
  return {
    id,
    type: type as TaskRecord['type'],
    status: status as TaskRecord['status'],
    payload: {},
    createdAt,
    updatedAt: createdAt,
  };
}

describe('filterAndSortTasks', () => {
  it('无过滤条件时按创建时间升序返回', () => {
    const tasks = [
      task('b', 'pending', 'tts', '2026-01-01T00:00:02.000Z'),
      task('a', 'done', 'tts', '2026-01-01T00:00:01.000Z'),
      task('c', 'running', 'llm', '2026-01-01T00:00:03.000Z'),
    ];
    const result = filterAndSortTasks(tasks);
    assert.deepEqual(result.map((t) => t.id), ['a', 'b', 'c']);
  });

  it('按状态过滤', () => {
    const tasks = [
      task('a', 'done', 'tts', '2026-01-01T00:00:01.000Z'),
      task('b', 'running', 'llm', '2026-01-01T00:00:02.000Z'),
      task('c', 'done', 'llm', '2026-01-01T00:00:03.000Z'),
    ];
    const filter: TaskListFilter = { status: 'done' as never };
    const result = filterAndSortTasks(tasks, filter);
    assert.deepEqual(result.map((t) => t.id), ['a', 'c']);
  });

  it('按类型过滤', () => {
    const tasks = [
      task('a', 'pending', 'tts', '2026-01-01T00:00:01.000Z'),
      task('b', 'pending', 'llm', '2026-01-01T00:00:02.000Z'),
    ];
    const filter: TaskListFilter = { type: 'llm' as never };
    const result = filterAndSortTasks(tasks, filter);
    assert.deepEqual(result.map((t) => t.id), ['b']);
  });

  it('同时按状态与类型过滤', () => {
    const tasks = [
      task('a', 'done', 'tts', '2026-01-01T00:00:01.000Z'),
      task('b', 'done', 'llm', '2026-01-01T00:00:02.000Z'),
      task('c', 'pending', 'tts', '2026-01-01T00:00:03.000Z'),
    ];
    const filter: TaskListFilter = { status: 'done' as never, type: 'tts' as never };
    const result = filterAndSortTasks(tasks, filter);
    assert.deepEqual(result.map((t) => t.id), ['a']);
  });

  it('空输入返回空数组且不原地修改', () => {
    assert.deepEqual(filterAndSortTasks([]), []);
    const tasks = [task('a', 'pending', 'tts', '2026-01-01T00:00:01.000Z')];
    filterAndSortTasks(tasks);
    assert.equal(tasks.length, 1, '不应原地修改入参数组');
  });
});
