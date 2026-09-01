/**
 * 平台发布规格与能力位单测(PRD-v1.7 FR-4)
 * 覆盖:规格常量完整性 / 预检阻断与警告 / 阻断消息 / 物料包构造
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISH_SPECS,
  validatePublishSpec,
  specBlockMessage,
  buildPublishKit,
} from '../publish-spec';
import type { PublishParams } from '../types';

describe('PUBLISH_SPECS', () => {
  it('五个平台均有规格定义', () => {
    for (const p of ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'shipinhao'] as const) {
      const spec = PUBLISH_SPECS[p];
      assert.ok(spec.titleLimit > 0, `${p} 标题上限非法`);
      assert.ok(spec.tagLimit >= 0);
      assert.ok(spec.uploadUrl.startsWith('https://'));
    }
  });

  it('视频号为半自动降级平台,其余为全自动', () => {
    assert.equal(PUBLISH_SPECS.shipinhao.autoPublish, false);
    assert.equal(PUBLISH_SPECS.douyin.autoPublish, true);
    assert.equal(PUBLISH_SPECS.kuaishou.autoPublish, true);
    assert.equal(PUBLISH_SPECS.xiaohongshu.autoPublish, true);
    assert.equal(PUBLISH_SPECS.bilibili.autoPublish, true);
  });
});

describe('validatePublishSpec', () => {
  it('合法参数 → 无问题项', () => {
    const params: PublishParams = { platform: 'douyin', videoPath: '/v.mp4', title: '正常标题' };
    assert.deepEqual(validatePublishSpec(params), []);
  });

  it('空标题 → 阻断', () => {
    const params: PublishParams = { platform: 'douyin', videoPath: '/v.mp4', title: '  ' };
    const issues = validatePublishSpec(params);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, 'block');
  });

  it('标题超限 → 阻断(小红书 20 字上限)', () => {
    const params: PublishParams = {
      platform: 'xiaohongshu',
      videoPath: '/v.mp4',
      title: '一'.repeat(21),
    };
    const issues = validatePublishSpec(params);
    assert.equal(issues[0].level, 'block');
    assert.equal(issues[0].field, 'title');
  });

  it('标题接近上限 → 警告(>=90%)', () => {
    const params: PublishParams = {
      platform: 'xiaohongshu',
      videoPath: '/v.mp4',
      title: '一'.repeat(19),
    };
    const issues = validatePublishSpec(params);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, 'warn');
  });

  it('标签超限 → 阻断', () => {
    const params: PublishParams = {
      platform: 'douyin',
      videoPath: '/v.mp4',
      title: '标题',
      tags: Array.from({ length: 11 }, (_, i) => `标签${i}`),
    };
    const issues = validatePublishSpec(params);
    assert.equal(issues[0].level, 'block');
    assert.equal(issues[0].field, 'tags');
  });

  it('视频号不支持话题:任何标签 → 阻断', () => {
    const params: PublishParams = {
      platform: 'shipinhao',
      videoPath: '/v.mp4',
      title: '标题',
      tags: ['搞笑'],
    };
    const issues = validatePublishSpec(params);
    assert.equal(issues[0].level, 'block');
    assert.equal(issues[0].field, 'tags');
  });
});

describe('specBlockMessage', () => {
  it('仅警告时返回 null', () => {
    assert.equal(specBlockMessage([{ level: 'warn', field: 'title', message: '接近上限' }]), null);
  });

  it('阻断项合并为单条消息', () => {
    const msg = specBlockMessage([
      { level: 'warn', field: 'title', message: '警告项' },
      { level: 'block', field: 'title', message: '标题超长' },
      { level: 'block', field: 'tags', message: '标签过多' },
    ]);
    assert.equal(msg, '标题超长;标签过多');
  });
});

describe('buildPublishKit', () => {
  it('物料包字段完整映射', () => {
    const params: PublishParams = {
      platform: 'shipinhao',
      videoPath: 'F:/v.mp4',
      title: '标题',
      description: '描述',
      tags: ['a'],
      coverPath: 'F:/c.jpg',
    };
    const spec = PUBLISH_SPECS.shipinhao;
    const kit = buildPublishKit('task-1', params, spec, '微信视频号');
    assert.equal(kit.taskId, 'task-1');
    assert.equal(kit.platform, 'shipinhao');
    assert.equal(kit.platformName, '微信视频号');
    assert.equal(kit.title, '标题');
    assert.equal(kit.description, '描述');
    assert.deepEqual(kit.tags, ['a']);
    assert.equal(kit.videoPath, 'F:/v.mp4');
    assert.equal(kit.coverPath, 'F:/c.jpg');
    assert.equal(kit.uploadUrl, spec.uploadUrl);
    assert.ok(!Number.isNaN(Date.parse(kit.generatedAt)));
  });
});
