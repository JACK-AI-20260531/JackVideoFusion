/**
 * 自动发布任务队列流程单测
 * 职责:通过依赖注入 mock 验证 enqueue/cancel/pause/resume/retry/listScheduled 等队列流程
 * 说明:注入 mock taskQueue 与 adapterFactory,绕过真实浏览器与全局单例
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/publish-queue-flow.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublishQueue } from '../publish-queue.ts';
import type { TaskQueue, TaskItem } from '../task-queue/types.ts';
import type {
  PublishTask,
  PublishParams,
  PublishResult,
  PlatformAdapter,
} from '../types.ts';
import { CancelToken } from '../ffmpeg/types';

/** 可配置行为的 mock 适配器 */
class MockAdapter implements PlatformAdapter {
  public static publishImpl: (params: PublishParams, token: CancelToken, onProgress: (p: number) => void) => Promise<PublishResult> = async () => ({
    platform: 'douyin',
    success: true,
    publishTime: new Date().toISOString(),
  });

  async login() {
    return { platform: 'douyin', loginStatus: 'logged-in' as const };
  }
  async checkLogin() {
    return { platform: 'douyin', loginStatus: 'logged-in' as const };
  }
  async logout() {
    return undefined;
  }
  publish(params: PublishParams, token: CancelToken, onProgress: (p: number) => void) {
    return MockAdapter.publishImpl(params, token, onProgress);
  }
}

/** 内存版 mock taskQueue */
function makeMockTaskQueue() {
  const items = new Map<string, TaskItem>();
  const log: string[] = [];
  const tq: TaskQueue = {
    enqueue: (task) => {
      items.set(task.id, task);
      log.push(`enqueue:${task.id}`);
      return task.id;
    },
    pause: (id) => {
      log.push(`pause:${id}`);
    },
    resume: (id) => {
      log.push(`resume:${id}`);
    },
    cancel: (id) => {
      log.push(`cancel:${id}`);
    },
    list: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
    saveCheckpoint: () => undefined,
    loadCheckpoint: () => null,
    complete: (id, out) => {
      items.get(id)!.status = 'completed';
      items.get(id)!.output = out;
      log.push(`complete:${id}`);
    },
    fail: (id) => {
      items.get(id)!.status = 'failed';
      log.push(`fail:${id}`);
    },
    updateProgress: (id) => {
      log.push(`progress:${id}`);
    },
    setConcurrency: () => undefined,
    restoreOnStartup: () => undefined,
  };
  return { tq, items, log };
}

function makeQueue() {
  const ctx = makeMockTaskQueue();
  const q = new PublishQueue({
    taskQueue: ctx.tq,
    adapterFactory: () => new MockAdapter(),
  });
  return { q, ...ctx };
}

function param(over: Partial<PublishParams> = {}): PublishParams {
  return {
    platform: 'douyin',
    videoPath: '/v.mp4',
    title: '标题',
    ...over,
  };
}

/** 等待微任务与宏任务链清空,让串行链执行到位 */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PublishQueue.enqueue (立即发布)', () => {
  it('立即发布成功:更新状态为 completed 并调用 taskQueue.complete', async () => {
    MockAdapter.publishImpl = async () => ({
      platform: 'douyin',
      success: true,
      publishTime: new Date().toISOString(),
    });
    const { q, items, log } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    await flush();
    assert.equal(items.get(task.id)!.status, 'completed');
    assert.ok(log.some((l) => l.startsWith('complete:')), '应调用 complete');
    assert.equal(task.status, 'completed');
    assert.equal(task.progress, 100);
  });

  it('发布失败:状态为 failed 并调用 taskQueue.fail', async () => {
    MockAdapter.publishImpl = async () => ({
      platform: 'douyin',
      success: false,
      publishTime: new Date().toISOString(),
    });
    const { q, log } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    await flush();
    assert.ok(log.some((l) => l.startsWith('fail:')), '应调用 fail');
    assert.equal(task.status, 'failed');
  });

  it('适配器抛错:状态为 failed 且记录错误信息', async () => {
    MockAdapter.publishImpl = async () => {
      throw new Error('网络异常');
    };
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    await flush();
    assert.equal(task.status, 'failed');
    assert.ok((task.error ?? '').includes('网络异常'));
  });

  it('列表按任务加入顺序记录', async () => {
    MockAdapter.publishImpl = async () => ({ platform: 'douyin', success: true, publishTime: '' });
    const { q } = makeQueue();
    const a = q.createTask(param({ title: 'a' }));
    const b = q.createTask(param({ title: 'b' }));
    q.enqueue(a);
    q.enqueue(b);
    await flush();
    const list = q.list();
    assert.deepEqual(list.map((t) => t.params.title), ['a', 'b']);
  });
});

describe('PublishQueue.enqueue (定时发布)', () => {
  it('未来 scheduledAt 登记定时器,不立即执行', async () => {
    const { q } = makeQueue();
    const future = new Date(Date.now() + 60_000).toISOString();
    const task = q.createTask(param({ scheduledAt: future }));
    q.enqueue(task);
    // 不应立刻执行
    assert.equal(task.status, 'pending');
    assert.deepEqual(q.listScheduled(), [task.id]);
    q.cancel(task.id);
    await flush();
    // 取消后定时列表为空,且不执行
    assert.deepEqual(q.listScheduled(), []);
  });

  it('过去的 scheduledAt 立即执行(不排定)', async () => {
    MockAdapter.publishImpl = async () => ({ platform: 'douyin', success: true, publishTime: '' });
    const { q, log } = makeQueue();
    const past = new Date(Date.now() - 10_000).toISOString();
    const task = q.createTask(param({ scheduledAt: past }));
    q.enqueue(task);
    await flush();
    assert.deepEqual(q.listScheduled(), []);
    assert.equal(task.status, 'completed');
  });

  it('cancel 清理定时器并置为 cancelled', async () => {
    const { q } = makeQueue();
    const future = new Date(Date.now() + 120_000).toISOString();
    const task = q.createTask(param({ scheduledAt: future }));
    q.enqueue(task);
    q.cancel(task.id);
    assert.equal(task.status, 'cancelled');
    assert.deepEqual(q.listScheduled(), []);
  });
});

describe('PublishQueue.pause / resume', () => {
  it('pause 非终态任务返回 true,并置为 paused', () => {
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    const ok = q.pause(task.id);
    assert.equal(ok, true);
    assert.equal(task.status, 'paused');
  });

  it('pause 不存在的任务返回 false', () => {
    const { q } = makeQueue();
    assert.equal(q.pause('no-such'), false);
  });

  it('不可暂停终态任务返回 false', async () => {
    MockAdapter.publishImpl = async () => ({ platform: 'douyin', success: true, publishTime: '' });
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    await flush();
    assert.equal(task.status, 'completed');
    assert.equal(q.pause(task.id), false);
  });

  it('resume 未暂停的任务返回 false', () => {
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    assert.equal(q.resume(task.id), false);
  });
});

describe('PublishQueue.retry', () => {
  it('仅 failed 任务可重试,置为 pending 并重新入队执行', async () => {
    MockAdapter.publishImpl = async () => {
      throw new Error('失败');
    };
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    await flush();
    assert.equal(task.status, 'failed');

    const ok = q.retry(task.id);
    assert.equal(ok, true);
    // 重试后同步置回 pending 并重新入队(实际执行受频率限制,不等待完成)
    assert.equal(task.status, 'pending');
    assert.equal(task.progress, 0);
    q.cancel(task.id);
  });

  it('非 failed 任务不可重试返回 false', () => {
    const { q } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    assert.equal(q.retry(task.id), false);
  });
});

describe('PublishQueue 取消令牌', () => {
  it('任务入队后取消:置为 cancelled 并调用 taskQueue.cancel', () => {
    const { q, log } = makeQueue();
    const task = q.createTask(param());
    q.enqueue(task);
    q.cancel(task.id);
    assert.equal(task.status, 'cancelled');
    assert.ok(log.some((l) => l.startsWith('cancel:')));
  });
});

describe('PublishQueue 半自动降级 (autoPublish=false, PRD-v1.7 FR-4)', () => {
  it('shipinhao 任务:生成物料包 + 打开上传页,标记 completed(assisted)', async () => {
    const ctx = makeMockTaskQueue();
    const kits: string[] = [];
    const opened: string[] = [];
    const q = new PublishQueue({
      taskQueue: ctx.tq,
      adapterFactory: () => new MockAdapter(),
      writeKit: async (kit) => {
        kits.push(kit.taskId);
        return `/kits/${kit.taskId}.json`;
      },
      openUploadPage: async (p) => {
        opened.push(p);
      },
    });
    const task = q.createTask(param({ platform: 'shipinhao' }));
    q.enqueue(task);
    await flush();

    assert.equal(task.status, 'completed');
    assert.equal(task.progress, 100);
    assert.equal(task.result?.assisted, true);
    assert.equal(task.result?.kitPath, `/kits/${task.id}.json`);
    assert.deepEqual(kits, [task.id]);
    assert.deepEqual(opened, ['shipinhao']);
  });

  it('物料包写入失败 → 任务 failed(可重试)', async () => {
    const ctx = makeMockTaskQueue();
    const q = new PublishQueue({
      taskQueue: ctx.tq,
      adapterFactory: () => new MockAdapter(),
      writeKit: async () => {
        throw new Error('disk full');
      },
      openUploadPage: async () => undefined,
    });
    const task = q.createTask(param({ platform: 'shipinhao' }));
    q.enqueue(task);
    await flush();

    assert.equal(task.status, 'failed');
    assert.ok((task.error ?? '').includes('半自动发布失败'));
    assert.equal(task.result?.success, false);
  });

  it('全自动平台(douyin)不走半自动分支', async () => {
    MockAdapter.publishImpl = async () => ({
      platform: 'douyin',
      success: true,
      publishTime: new Date().toISOString(),
    });
    const ctx = makeMockTaskQueue();
    let kitCalls = 0;
    const q = new PublishQueue({
      taskQueue: ctx.tq,
      adapterFactory: () => new MockAdapter(),
      writeKit: async () => {
        kitCalls++;
        return '/kits/x.json';
      },
      openUploadPage: async () => undefined,
    });
    const task = q.createTask(param({ platform: 'douyin' }));
    q.enqueue(task);
    await flush();

    assert.equal(task.status, 'completed');
    assert.equal(task.result?.assisted, undefined);
    assert.equal(kitCalls, 0);
  });
});
