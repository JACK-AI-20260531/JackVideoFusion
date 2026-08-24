/**
 * 日志广播防御性测试
 * 职责:验证非 Electron 主进程环境下 broadcastLog 安全跳过(短路分支)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastLog } from '../log-broadcaster.ts';

describe('broadcastLog（非 Electron 环境）', () => {
  it('BrowserWindow 不可用时安全返回,不抛错', () => {
    assert.doesNotThrow(() => {
      broadcastLog({
        time: Date.now(),
        level: 'info',
        message: 'test',
        scope: 'unit',
      } as any);
    });
  });
});
