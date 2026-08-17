/**
 * 主进程配置服务默认值/合并单测
 * 职责:验证 deepMerge 深合并、patch 缺子结构保留默认(向后兼容)、createDefaultConfig 深拷贝
 * 运行:node --test --experimental-strip-types src/main/services/config-service/__tests__/defaults.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, createDefaultConfig, DEFAULT_CONFIG } from '../defaults.ts';

describe('deepMerge', () => {
  it('递归合并嵌套子结构且未覆盖字段保留 base 默认', () => {
    const base = { watermark: { enabled: false, opacity: 80, type: 'text' } };
    const patch = { watermark: { opacity: 50 } };
    const merged = deepMerge(base as never, patch as never);
    assert.equal(merged.watermark.enabled, false);
    assert.equal(merged.watermark.opacity, 50);
    assert.equal(merged.watermark.type, 'text');
  });

  it('patch 缺失整个子对象时保留 base 默认(向后兼容旧数据)', () => {
    const base = { export: { dir: '', tag: 'a' } };
    const merged = deepMerge(base as never, {} as never);
    assert.deepEqual(merged, { export: { dir: '', tag: 'a' } });
  });

  it('base 含子对象而 patch 完全不提供时,默认结构得以保留', () => {
    const base = { defaults: { defResolution: '1080p', llm: { model: '', apiKey: '' } } };
    const merged = deepMerge(base as never, { defaults: { llm: { model: 'm1' } } } as never);
    assert.equal(merged.defaults.defResolution, '1080p');
    assert.equal(merged.defaults.llm.model, 'm1');
    assert.equal(merged.defaults.llm.apiKey, '');
  });

  it('patch 为 null 或 undefined 时返回 base 的浅拷贝', () => {
    const base = { a: 1 };
    const merged = deepMerge(base as never, null);
    assert.deepEqual(merged, { a: 1 });
    merged.a = 2;
    assert.equal(base.a, 1);
  });
});

describe('createDefaultConfig', () => {
  it('返回独立深拷贝(DEFAULT_CONFIG 的嵌套对象不被共享)', () => {
    const c1 = createDefaultConfig();
    const c2 = createDefaultConfig();
    c1.watermark.enabled = true;
    assert.equal(c2.watermark.enabled, false);
    assert.equal(DEFAULT_CONFIG.watermark.enabled, false);
  });

  it('默认配置包含 split 业务子结构与默认值', () => {
    const c = createDefaultConfig();
    assert.equal(c.split.segmentSec, 10);
    assert.equal(c.split.keepQuality, true);
    assert.equal(c.split.stripAudio, false);
    assert.equal(c.split.namingRule, '{name}_{index}');
  });

  it('默认配置包含 tts 业务子结构与默认值', () => {
    const c = createDefaultConfig();
    assert.equal(c.tts.voice, '');
    assert.equal(c.tts.generateSrt, false);
  });

  it('默认配置包含 mix 业务子结构与默认值', () => {
    const c = createDefaultConfig();
    assert.equal(c.mix.perFolderCount, 3);
    assert.equal(c.mix.targetDurationSec, 0);
    assert.equal(c.mix.uniqueReuse, true);
  });

  it('默认配置 watermark/subtitle 与渲染层扩展字段对齐', () => {
    const c = createDefaultConfig();
    assert.equal(c.watermark.marginX, 20);
    assert.equal(c.watermark.marginY, 20);
    assert.equal(c.watermark.fontSize, 24);
    assert.equal(c.watermark.fontColor, 'white');
    assert.equal(c.subtitle.shadow, false);
    assert.equal(c.subtitle.align, 'center');
  });
});
