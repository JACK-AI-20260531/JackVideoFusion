/**
 * FFmpeg 进度推送防御性测试
 * 职责:验证非 Electron 主进程环境下 emitProgress 安全跳过(短路分支)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitProgress } from '../progress.ts';

describe('emitProgress（非 Electron 环境）', () => {
  it('BrowserWindow 不可用时安全返回,不抛错', () => {
    // 纯 Node 测试环境 electron.BrowserWindow 为 undefined,应走防御短路
    assert.doesNotThrow(() => {
      emitProgress({ taskId: 't1', stage: 0, percent: 50, detail: '', status: 'running' } as any);
    });
  });
});
