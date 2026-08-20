/**
 * 平台适配器工厂单测
 * 职责:验证 PLATFORM_NAMES 中文名映射与 adapterFactory 对每个支持平台的实例化,
 *      以及未知平台的错误处理。纯逻辑,不依赖浏览器/electron。
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/adapter-factory.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFactory, PLATFORM_NAMES } from '../adapters/index.ts';
import { DouyinAdapter } from '../adapters/douyin-adapter.ts';
import { KuaishouAdapter } from '../adapters/kuaishou-adapter.ts';
import { XiaohongshuAdapter } from '../adapters/xiaohongshu-adapter.ts';
import { BilibiliAdapter } from '../adapters/bilibili-adapter.ts';
import { SpzxAdapter } from '../adapters/spzx-adapter.ts';
import type { PublishPlatform } from '../types.ts';

/** 全部支持的平台 */
const ALL_PLATFORMS: PublishPlatform[] = [
  'douyin',
  'kuaishou',
  'xiaohongshu',
  'bilibili',
  'shipinhao',
];

describe('PLATFORM_NAMES', () => {
  it('覆盖全部支持平台的中文名', () => {
    for (const p of ALL_PLATFORMS) {
      const name = PLATFORM_NAMES[p];
      assert.equal(typeof name, 'string');
      assert.ok(name.length > 0, `平台 ${p} 缺少中文名`);
    }
  });

  it('微信视频号映射为“微信视频号”', () => {
    assert.equal(PLATFORM_NAMES['shipinhao'], '微信视频号');
  });
});

describe('adapterFactory', () => {
  it('对每个支持平台返回实现了 PlatformAdapter 接口的实例', () => {
    for (const p of ALL_PLATFORMS) {
      const adapter = adapterFactory(p);
      assert.ok(adapter, `平台 ${p} 未返回适配器`);
      assert.equal(typeof adapter.login, 'function');
      assert.equal(typeof adapter.checkLogin, 'function');
      assert.equal(typeof adapter.logout, 'function');
      assert.equal(typeof adapter.publish, 'function');
    }
  });

  it('shipinhao 返回 SpzxAdapter(video-adapter 视频号)', () => {
    assert.ok(adapterFactory('shipinhao') instanceof SpzxAdapter);
  });

  it('各平台返回对应适配器类', () => {
    assert.ok(adapterFactory('douyin') instanceof DouyinAdapter);
    assert.ok(adapterFactory('kuaishou') instanceof KuaishouAdapter);
    assert.ok(adapterFactory('xiaohongshu') instanceof XiaohongshuAdapter);
    assert.ok(adapterFactory('bilibili') instanceof BilibiliAdapter);
  });

  it('未知平台抛出明确错误', () => {
    // 通过 unknown 强制绕过 TS 校验,验证运行时穷尽分支
    assert.throws(() => adapterFactory('unknown' as PublishPlatform), /不支持的平台/);
  });
});
