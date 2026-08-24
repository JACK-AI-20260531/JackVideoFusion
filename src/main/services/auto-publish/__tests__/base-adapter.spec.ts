/**
 * BasePlatformAdapter 纯逻辑测试
 * 职责:验证受保护的 buildTitleWithTags 标题+话题拼接逻辑(纯字符串操作)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFactory } from '../adapters/index.ts';

describe('BasePlatformAdapter.buildTitleWithTags', () => {
  const adapter: any = adapterFactory('douyin');

  it('无 tags 时原样返回标题', () => {
    assert.equal(adapter.buildTitleWithTags('我的视频'), '我的视频');
  });

  it('空数组 tags 时原样返回标题', () => {
    assert.equal(adapter.buildTitleWithTags('我的视频', []), '我的视频');
  });

  it('单个话题附加 # 前缀', () => {
    assert.equal(adapter.buildTitleWithTags('我的视频', ['旅行']), '我的视频 #旅行');
  });

  it('多个话题以空格连接', () => {
    assert.equal(
      adapter.buildTitleWithTags('我的视频', ['旅行', '美食', '日常']),
      '我的视频 #旅行 #美食 #日常',
    );
  });

  it('话题已带 # 时不重复添加', () => {
    assert.equal(adapter.buildTitleWithTags('我的视频', ['#旅行']), '我的视频 ##旅行');
  });
});
