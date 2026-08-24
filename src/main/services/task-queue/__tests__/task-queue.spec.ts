/**
 * 任务队列调度核心单测
 * 职责:通过依赖注入验证 enqueue 调度、并发限制、状态转换、进度钳制、
 *      checkpoint 委托、启动恢复等核心逻辑(不依赖 electron/磁盘)
 * 运行:npm run test 或 node --test --import tsx src/main/services/task-queue/__tests__/task-queue.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueueImpl } from '../task-queue.ts';
import type { TaskQueueDeps } from '../task-queue.ts';
import type { TaskItem, Checkpoint } from '../types.ts';

/** 收集各依赖调用与内存状态 */
function makeQueue(over: Partial<TaskQueueDeps> = {}) {
  const persisted: TaskItem[] = [];
  const progressLog: TaskItem[] = [];
  const checkpoints = new Map<string, Checkpoint>();
  const removedCheckpoints: string[] = [];
  const nowValue = '2026-01-01T00:00:00.000Z';

  const q = new TaskQueueImpl({
    loadPersisted: () => persisted,
    persist: (tasks) => {
      persisted.length = 0;
      persisted.push(...tasks);
    },
    emitProgress: (task) => progressLog.push(task),
    saveCheckpoint: (taskId, step, progress, ctx) => {
      checkpoints.set(taskId, { taskId, step, progress, context: ctx, savedAt: nowValue as string });
    },
    loadCheckpoint: (taskId) => checkpoints.get(taskId) ?? null,
    removeCheckpoint: (taskId) => {
      removedCheckpoints.push(taskId);
      checkpoints.delete(taskId);
    },
    now: () => nowValue,
    ...over,
  });
  return { q, persisted, progressLog, checkpoints, removedCheckpoints, nowValue: nowValue as string };
}

function task(id: string, createdAt = '2026-01-01T00:00:00.000Z'): TaskItem {
  return {
    id,
    type: 'test',
    title: id,
    status: 'pending',
    progress: 0,
    params: {},
    createdAt,
  };
}

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

describe('TaskQueue.enqueue 调度', () => {
  it('入队后自动调度为 running(并发=1)', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    assert.equal(q.get('a')!.status, 'running');
  });

  it('并发=1 时第二个任务保持 pending,直到首个完成', () => {
    const { q } = makeQueue();
    q.enqueue(task('a', T0));
    q.enqueue(task('b', T1));
    assert.equal(q.get('a')!.status, 'running');
    assert.equal(q.get('b')!.status, 'pending');
    q.complete('a');
    assert.equal(q.get('b')!.status, 'running');
  });

  it('并发=2 时两个 pending 同时转为 running', () => {
    const { q } = makeQueue();
    q.setConcurrency(2);
    q.enqueue(task('a', T0));
    q.enqueue(task('b', T1));
    assert.equal(q.get('a')!.status, 'running');
    assert.equal(q.get('b')!.status, 'running');
  });

  it('enqueue 无 id 时自动生成 UUID', () => {
    const { q } = makeQueue();
    const id = q.enqueue({ ...task(''), id: undefined as never });
    assert.ok(id.length > 0);
    assert.ok(q.get(id));
  });
});

describe('TaskQueue.setStateConcurrency', () => {
  it('setConcurrency 下限为 1', () => {
    const { q } = makeQueue();
    q.setConcurrency(0);
    q.setConcurrency(-5);
    q.enqueue(task('a'));
    assert.equal(q.get('a')!.status, 'running');
  });
});

describe('TaskQueue 状态转换', () => {
  it('complete 设置 output 与 finishedAt', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    q.complete('a', '/out.mp4');
    const t = q.get('a')!;
    assert.equal(t.status, 'completed');
    assert.equal(t.output, '/out.mp4');
    assert.equal(t.finishedAt, T0);
  });

  it('fail 记录 error 并推进后续任务', () => {
    const { q } = makeQueue();
    q.enqueue(task('a', T0));
    q.enqueue(task('b', T1));
    q.fail('a', '出错了');
    assert.equal(q.get('a')!.status, 'failed');
    assert.equal(q.get('a')!.error, '出错了');
    assert.equal(q.get('b')!.status, 'running');
  });

  it('cancel 转为 cancelled 并推进后续任务', () => {
    const { q } = makeQueue();
    q.enqueue(task('a', T0));
    q.enqueue(task('b', T1));
    q.cancel('a');
    assert.equal(q.get('a')!.status, 'cancelled');
    assert.equal(q.get('b')!.status, 'running');
  });

  it('对不存在任务调用状态转换抛错', () => {
    const { q } = makeQueue();
    assert.throws(() => q.complete('no-such'), /任务不存在/);
    assert.throws(() => q.pause('no-such'), /任务不存在/);
  });
});

describe('TaskQueue pause / resume', () => {
  it('pause 使 running → paused;resume 恢复为 running', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    assert.equal(q.get('a')!.status, 'running');
    q.pause('a');
    assert.equal(q.get('a')!.status, 'paused');
    q.resume('a');
    assert.equal(q.get('a')!.status, 'running');
  });
});

describe('TaskQueue.updateProgress 钳制', () => {
  it('越界进度被钳制到 0-100', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    q.updateProgress('a', 150);
    assert.equal(q.get('a')!.progress, 100);
    q.updateProgress('a', -10);
    assert.equal(q.get('a')!.progress, 0);
    q.updateProgress('a', 55);
    assert.equal(q.get('a')!.progress, 55);
  });

  it('对不存在任务更新进度静默返回', () => {
    const { q } = makeQueue();
    q.updateProgress('no-such', 50);
  });
});

describe('TaskQueue checkpoint 委托', () => {
  it('saveCheckpoint 委托并同步进度到任务', () => {
    const { q, checkpoints } = makeQueue();
    q.enqueue(task('a'));
    q.saveCheckpoint('a', 'step-1', 40, { key: 1 });
    const cp = checkpoints.get('a');
    assert.ok(cp);
    assert.equal(cp!.step, 'step-1');
    assert.equal(cp!.progress, 40);
    assert.equal(q.get('a')!.progress, 40);
  });

  it('loadCheckpoint 未保存时返回 null', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    assert.equal(q.loadCheckpoint('a'), null);
  });

  it('完成/取消任务时移除检查点', () => {
    const { q, removedCheckpoints } = makeQueue();
    q.enqueue(task('a'));
    q.saveCheckpoint('a', 's', 30, null);
    q.complete('a');
    assert.ok(removedCheckpoints.includes('a'));
  });
});

describe('TaskQueue 进度推送', () => {
  it('状态变更与进度更新触发 emitProgress', () => {
    const { q, progressLog } = makeQueue();
    q.enqueue(task('a'));
    q.updateProgress('a', 20);
    assert.ok(progressLog.length >= 2);
  });
});

describe('TaskQueue.restoreOnStartup', () => {
  it('将所有 running 任务转为 paused', () => {
    const { q } = makeQueue();
    q.enqueue(task('a'));
    assert.equal(q.get('a')!.status, 'running');
    // 用持久化数据重新构造队列,模拟启动恢复
    const { q: q2 } = makeQueue({ loadPersisted: () => q.list() });
    q2.restoreOnStartup();
    assert.equal(q2.get('a')!.status, 'paused');
  });
});

describe('TaskQueue 持久化与查询', () => {
  it('每次变更触发持久化', () => {
    const { q, persisted } = makeQueue();
    q.enqueue(task('a'));
    assert.equal(persisted.some((t) => t.id === 'a'), true);
  });

  it('list 返回所有任务', () => {
    const { q } = makeQueue();
    q.setConcurrency(2);
    q.enqueue(task('a'));
    q.enqueue(task('b'));
    assert.deepEqual(q.list().map((t) => t.id).sort(), ['a', 'b']);
  });

  it('get 不存在任务返回 null', () => {
    const { q } = makeQueue();
    assert.equal(q.get('no-such'), null);
  });
});
