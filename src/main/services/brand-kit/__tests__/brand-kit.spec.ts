/**
 * 品牌套件单测(PRD-v1.7 FR-7)
 * 覆盖:滤镜链编译 / 视觉项判定 / 配置存取(注入持久化)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrandStore, buildBrandFilter, hasBrandVisuals } from '../brand-kit.ts';
import type { BrandKitConfig } from '../brand-kit';

describe('buildBrandFilter', () => {
  it('空配置 → 空串', () => {
    assert.equal(buildBrandFilter({}), '');
    assert.equal(buildBrandFilter(null), '');
    assert.equal(buildBrandFilter({ aspect: 'none' }), '');
  });

  it('仅滤镜 → eq 链', () => {
    const vf = buildBrandFilter({ filter: { brightness: 0.05, contrast: 1.1, saturation: 1.05 } });
    assert.equal(vf, 'eq=brightness=0.05:contrast=1.1:saturation=1.05');
  });

  it('仅比例 → scale+pad 链(9:16)', () => {
    const vf = buildBrandFilter({ aspect: '9:16' });
    assert.equal(
      vf,
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    );
  });

  it('滤镜 + 比例 → 逗号拼接', () => {
    const vf = buildBrandFilter({ filter: { contrast: 1.2 }, aspect: '16:9' });
    assert.ok(vf.startsWith('eq=contrast=1.2,'));
    assert.ok(vf.includes('scale=1920:1080'));
  });

  it('eq 数值越界被钳制', () => {
    const vf = buildBrandFilter({ filter: { brightness: 5, contrast: -1, saturation: 99 } });
    assert.equal(vf, 'eq=brightness=1:contrast=0:saturation=2');
  });
});

describe('hasBrandVisuals', () => {
  it('判定滤镜/比例存在', () => {
    assert.equal(hasBrandVisuals({}), false);
    assert.equal(hasBrandVisuals({ filter: {} }), false); // 空 filter 对象无有效项
    assert.equal(hasBrandVisuals({ filter: { brightness: 0 } }), true); // 存在数值键即生效
    assert.equal(hasBrandVisuals({ filter: { brightness: 0.1 } }), true);
    assert.equal(hasBrandVisuals({ aspect: '9:16' }), true);
    assert.equal(hasBrandVisuals({ watermarkImage: 'a.png' }), false); // 水印不算画面级
  });
});

describe('BrandStore', () => {
  it('setConfig 浅合并并落盘', () => {
    const persisted: BrandKitConfig[] = [];
    const store = new BrandStore({
      load: () => ({}),
      persist: (c) => persisted.push(c),
    });
    store.setConfig({ watermarkImage: 'a.png' });
    const cfg = store.setConfig({ filter: { contrast: 1.1 } });
    assert.equal(cfg.watermarkImage, 'a.png');
    assert.equal(cfg.filter?.contrast, 1.1);
    assert.equal(persisted.length, 2);
  });

  it('getConfig 返回副本(修改不影响内部状态)', () => {
    const store = new BrandStore({ load: () => ({ introPath: 'x.mp4' }), persist: () => undefined });
    const cfg = store.getConfig();
    cfg.introPath = 'changed';
    assert.equal(store.getConfig().introPath, 'x.mp4');
  });
});
