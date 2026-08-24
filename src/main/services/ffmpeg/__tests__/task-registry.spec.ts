/**
 * FFmpeg 任务注册中心单测
 * 职责:验证 taskRegistry 的 register/unregister/cancel 行为
 * 说明:纯内存 Map 逻辑,无任何 IO/electron 依赖
 * 运行:npm run test 或 node --test --import tsx src/main/services/ffmpeg/__tests__/task-registry.spec.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { taskRegistry } from '../task-registry.ts';

describe('taskRegistry', () => {
  beforeEach(() => {
    // 清理所有已注册项,保证用例间隔离
    for (const id of ['t1', 't2', 't3']) {
      taskRegistry.cancel(id);
    }
  });

  it('register 后可 cancel 并触发取消器', () => {
    let called = false;
    taskRegistry.register('t1', () => {
      called = true;
    });
    const ok = taskRegistry.cancel('t1');
    assert.equal(ok, true);
    assert.equal(called, true);
  });

  it('cancel 未注册任务返回 false 且不抛错', () => {
    const ok = taskRegistry.cancel('no-such');
    assert.equal(ok, false);
  });

  it('cancel 后从注册表移除(重复 cancel 返回 false)', () => {
    taskRegistry.register('t2', () => undefined);
    assert.equal(taskRegistry.cancel('t2'), true);
    assert.equal(taskRegistry.cancel('t2'), false);
  });

  it('unregister 后 cancel 返回 false(任务正常结束)', () => {
    taskRegistry.register('t3', () => undefined);
    taskRegistry.unregister('t3');
    assert.equal(taskRegistry.cancel('t3'), false);
  });

  it('cancel 时取消器抛错被吞掉并返回 true', () => {
    taskRegistry.register('t1', () => {
      throw new Error('boom');
    });
    // 不应抛错,仍返回 true
    assert.equal(taskRegistry.cancel('t1'), true);
  });
});
