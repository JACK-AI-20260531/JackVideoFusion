/**
 * GPT-SoVITS 服务管理器纯逻辑单测
 * 职责:验证 buildSpawnArgs 启动参数构造
 * 说明:纯函数;checkInstalled/start/stop 等子进程管理方法不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/voice-clone/__tests__/service-manager.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnArgs } from '../service-manager.ts';
import { join } from 'path';
import type { GptSoVitsConfig } from '../types.ts';

function cfg(over = {}): GptSoVitsConfig {
  return { installPath: 'C:\\gptsovits', port: 9880, ...over };
}

describe('buildSpawnArgs', () => {
  it('首项为 python 可执行文件', () => {
    const args = buildSpawnArgs(cfg(), 'C:\\python\\python.exe');
    assert.equal(args[0], 'C:\\python\\python.exe');
  });

  it('包含 api_v2.py、端口与地址参数', () => {
    const args = buildSpawnArgs(cfg({ installPath: '/srv/gpt', port: 9001 }), 'py');
    assert.equal(args[1], join('/srv/gpt', 'api_v2.py'));
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('9001'));
    assert.ok(args.includes('-a'));
    assert.ok(args.includes('127.0.0.1'));
  });

  it('提供 modelPath 时追加 -g 参数', () => {
    const args = buildSpawnArgs(cfg({ modelPath: 'gpt.ckpt' }), 'py');
    assert.ok(args.includes('-g'));
    assert.ok(args.includes('gpt.ckpt'));
  });

  it('提供 sovitsModelPath 时追加 -s 参数', () => {
    const args = buildSpawnArgs(cfg({ sovitsModelPath: 'sovits.pth' }), 'py');
    assert.ok(args.includes('-s'));
    assert.ok(args.includes('sovits.pth'));
  });

  it('不提供模型路径时不追加 -g/-s', () => {
    const args = buildSpawnArgs(cfg(), 'py');
    assert.ok(!args.includes('-g'));
    assert.ok(!args.includes('-s'));
  });

  it('提供 host 时以 host 作为监听地址', () => {
    const args = buildSpawnArgs(cfg({ host: '192.168.1.50' }), 'py');
    assert.ok(args.includes('-a'));
    assert.ok(args.includes('192.168.1.50'));
  });
});
