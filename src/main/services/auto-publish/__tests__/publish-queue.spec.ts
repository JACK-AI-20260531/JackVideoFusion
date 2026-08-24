/**
 * 自动发布任务队列纯逻辑单测
 * 职责:验证 PublishQueue.createTask 生成任务对象的结构与初始状态
 * 说明:createTask 为无外部依赖的纯构造方法(仅用 Date/Math.random),
 *      enqueue/runOne 等依赖 taskQueue/适配器,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/publish-queue.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublishQueue } from '../publish-queue.ts';

function makeQueue(): PublishQueue {
  return new PublishQueue();
}

describe('PublishQueue.createTask', () => {
  it('生成任务含非空 id 与 pending 初始状态', () => {
    const q = makeQueue();
    const task = q.createTask({
      platform: 'douyin',
      videoPath: '/v.mp4',
      title: '测试视频',
    });
    assert.ok(task.id.length > 0);
    assert.equal(task.status, 'pending');
    assert.equal(task.progress, 0);
  });

  it('保留平台、视频路径与标题', () => {
    const q = makeQueue();
    const task = q.createTask({
      platform: 'bilibili',
      videoPath: '/x/b.mp4',
      title: '我的标题',
    });
    assert.equal(task.params.platform, 'bilibili');
    assert.equal(task.params.videoPath, '/x/b.mp4');
    assert.equal(task.params.title, '我的标题');
  });

  it('createdAt 为合法 ISO 时间字符串', () => {
    const q = makeQueue();
    const task = q.createTask({ platform: 'kuaishou', videoPath: '/v.mp4', title: 't' });
    const ts = Date.parse(task.createdAt);
    assert.ok(!Number.isNaN(ts), `createdAt 非法: ${task.createdAt}`);
  });

  it('不同任务 id 不相同', () => {
    const q = makeQueue();
    const t1 = q.createTask({ platform: 'douyin', videoPath: '/1.mp4', title: 'a' });
    const t2 = q.createTask({ platform: 'douyin', videoPath: '/2.mp4', title: 'b' });
    assert.notEqual(t1.id, t2.id);
  });

  it('可选字段(标签/描述/封面/定时)被保留', () => {
    const q = makeQueue();
    const task = q.createTask({
      platform: 'xiaohongshu',
      videoPath: '/v.mp4',
      title: 't',
      description: 'desc',
      tags: ['搞笑', '日常'],
      coverPath: '/cover.jpg',
      scheduledAt: '2026-02-01T00:00:00.000Z',
    });
    assert.deepEqual(task.params.tags, ['搞笑', '日常']);
    assert.equal(task.params.description, 'desc');
    assert.equal(task.params.coverPath, '/cover.jpg');
    assert.equal(task.params.scheduledAt, '2026-02-01T00:00:00.000Z');
  });
});
