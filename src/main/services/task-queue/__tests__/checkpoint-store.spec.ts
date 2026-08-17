/**
 * 检查点持久化存储单测
 * 职责:验证 saveCheckpoint/loadCheckpoint/removeCheckpoint/listCheckpointTaskIds
 *      基于 fs 的 JSON 落盘/读取/删除/列表行为
 * 说明:通过 _setCheckpointsDirForTest 注入临时目录,绕过 electron app 依赖,
 *      使持久化逻辑可在纯 Node 环境测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/task-queue/__tests__/checkpoint-store.spec.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  saveCheckpoint,
  loadCheckpoint,
  removeCheckpoint,
  listCheckpointTaskIds,
  _setCheckpointsDirForTest,
  _resetCheckpointsDirForTest,
  _createTestCheckpointsDir,
} from '../checkpoint-store.ts';

/** 当前用例的临时存储目录 */
let tempDir = '';

describe('checkpoint-store', () => {
  before(() => {
    tempDir = _createTestCheckpointsDir();
    _setCheckpointsDirForTest(tempDir);
  });

  after(() => {
    _resetCheckpointsDirForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 清空目录,保证用例间隔离
    for (const f of readdirSync(tempDir)) {
      rmSync(join(tempDir, f), { recursive: true, force: true });
    }
  });

  it('saveCheckpoint 写入 JSON 文件并包含时间戳', () => {
    saveCheckpoint('t1', 'step-a', 42, { key: 'val' });
    const fp = join(tempDir, 't1.json');
    assert.equal(existsSync(fp), true);
    const parsed = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
    assert.equal(parsed.taskId, 't1');
    assert.equal(parsed.step, 'step-a');
    assert.equal(parsed.progress, 42);
    assert.deepEqual(parsed.context, { key: 'val' });
    assert.ok(parsed.savedAt);
  });

  it('loadCheckpoint 读取已保存的检查点', () => {
    saveCheckpoint('t2', 'step-b', 80, { phase: 2 });
    const cp = loadCheckpoint('t2');
    assert.ok(cp);
    assert.equal(cp!.taskId, 't2');
    assert.equal(cp!.step, 'step-b');
    assert.equal(cp!.progress, 80);
    assert.deepEqual(cp!.context, { phase: 2 });
  });

  it('loadCheckpoint 对不存在或损坏文件返回 null', () => {
    assert.equal(loadCheckpoint('no-such'), null);
    // 写入非法 JSON 后应返回 null
    saveCheckpoint('bad', 's', 1, null);
    require('fs').writeFileSync(join(tempDir, 'bad.json'), '{not-json', 'utf8');
    assert.equal(loadCheckpoint('bad'), null);
  });

  it('saveCheckpoint 同名任务覆盖式更新(仅保留最新)', () => {
    saveCheckpoint('t3', 'v1', 10, null);
    saveCheckpoint('t3', 'v2', 90, { done: true });
    const cp = loadCheckpoint('t3');
    assert.equal(cp!.step, 'v2');
    assert.equal(cp!.progress, 90);
    // 目录中该任务只有一个文件
    const jsonFiles = readdirSync(tempDir).filter((f) => f.endsWith('.json'));
    assert.equal(jsonFiles.filter((f) => f === 't3.json').length, 1);
  });

  it('removeCheckpoint 删除检查点,不存在时静默', () => {
    saveCheckpoint('t4', 's', 1, null);
    assert.equal(loadCheckpoint('t4') !== null, true);
    removeCheckpoint('t4');
    assert.equal(loadCheckpoint('t4'), null);
    // 删除不存在的不抛错
    removeCheckpoint('t4');
  });

  it('listCheckpointTaskIds 列出所有任务并去扩展名', () => {
    saveCheckpoint('a', 's', 1, null);
    saveCheckpoint('b', 's', 1, null);
    saveCheckpoint('c', 's', 1, null);
    const ids = listCheckpointTaskIds().sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  });

  it('listCheckpointTaskIds 忽略非 .json 文件', () => {
    saveCheckpoint('keep', 's', 1, null);
    mkdirSync(join(tempDir, 'sub'), { recursive: true });
    require('fs').writeFileSync(join(tempDir, 'ignore.txt'), 'x', 'utf8');
    const ids = listCheckpointTaskIds();
    assert.deepEqual(ids, ['keep']);
  });
});
