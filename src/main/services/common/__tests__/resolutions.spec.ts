/**
 * 分辨率预设服务单测
 * 职责:验证 RESOLUTION_PRESETS 常量表、getResolution 查询与 fallback、
 *      buildScaleFilter scale/pad 滤镜字符串生成(keeepOriginal 分支)
 * 运行:npm run test 或 node --test --import tsx src/main/services/common/__tests__/resolutions.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLUTION_PRESETS,
  getResolution,
  buildScaleFilter,
} from '../resolutions.ts';

describe('RESOLUTION_PRESETS', () => {
  it('覆盖全部支持的分辨率预设', () => {
    const presets = RESOLUTION_PRESETS.map((r) => r.preset).sort();
    assert.deepEqual(presets, ['1080p', '4k', '720p']);
  });

  it('每个预设的宽高正确', () => {
    const byPreset = Object.fromEntries(
      RESOLUTION_PRESETS.map((r) => [r.preset, r]),
    );
    assert.equal(byPreset['720p'].width, 1280);
    assert.equal(byPreset['720p'].height, 720);
    assert.equal(byPreset['1080p'].width, 1920);
    assert.equal(byPreset['1080p'].height, 1080);
    assert.equal(byPreset['4k'].width, 3840);
    assert.equal(byPreset['4k'].height, 2160);
  });
});

describe('getResolution', () => {
  it('已知预设返回对应分辨率', () => {
    assert.equal(getResolution('720p').preset, '720p');
    assert.equal(getResolution('1080p').preset, '1080p');
    assert.equal(getResolution('4k').preset, '4k');
  });

  it('未知预设回退到 1080p', () => {
    const r = getResolution('2k' as never);
    assert.equal(r.preset, '1080p');
  });
});

describe('buildScaleFilter', () => {
  it('keepOriginal=true 返回空字符串(不做缩放)', () => {
    assert.equal(buildScaleFilter('1080p', true), '');
  });

  it('未保留原画质时生成 scale+pad 滤镜字符串', () => {
    const filter = buildScaleFilter('1080p', false);
    assert.ok(filter.includes('scale=1920:1080:force_original_aspect_ratio=decrease'));
    assert.ok(filter.includes('pad=1920:1080:(ow-iw)/2:(oh-ih)/2'));
  });

  it('不同预设生成不同尺寸', () => {
    const f720 = buildScaleFilter('720p', false);
    const f4k = buildScaleFilter('4k', false);
    assert.ok(f720.includes('scale=1280:720'));
    assert.ok(f4k.includes('scale=3840:2160'));
  });
});
