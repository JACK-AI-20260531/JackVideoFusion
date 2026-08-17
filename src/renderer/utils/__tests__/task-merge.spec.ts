/**
 * 任务列表合并纯函数单测
 * 职责:验证将主进程 taskQueue 任务合并进渲染层任务列表的正确性
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/task-merge.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskItem } from '../../stores/task';
import { mergeTaskLists } from '../task-merge.ts';

function makeTask(id: string, status: string, patch: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    type: 'ai-edit',
    title: `任务-${id}`,
    status: status as TaskItem['status'],
    progress: 0,
    params: {},
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

describe('mergeTaskLists', () => {
  it('新任务追加到末尾', () => {
    const existing = [makeTask('a', 'running')];
    const incoming = [makeTask('b', 'pending')];
    const result = mergeTaskLists(existing, incoming);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((t) => t.id), ['a', 'b']);
  });

  it('已存在任务按其 id 更新状态与进度', () => {
    const existing = [makeTask('a', 'running', { progress: 20 })];
    const incoming = [makeTask('a', 'completed', { progress: 100, finishedAt: 'x' })];
    const result = mergeTaskLists(existing, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'completed');
    assert.equal(result[0].progress, 100);
    assert.equal(result[0].finishedAt, 'x');
  });

  it('已存在任务覆盖其 error 字段', () => {
    const existing = [makeTask('a', 'running')];
    const incoming = [makeTask('a', 'failed', { error: 'FFmpeg 不可用' })];
    const result = mergeTaskLists(existing, incoming);
    assert.equal(result[0].status, 'failed');
    assert.equal(result[0].error, 'FFmpeg 不可用');
  });

  it('空输入安全返回', () => {
    assert.deepEqual(mergeTaskLists([], []), []);
    assert.equal(mergeTaskLists([makeTask('a', 'pending')], []).length, 1);
  });
});
