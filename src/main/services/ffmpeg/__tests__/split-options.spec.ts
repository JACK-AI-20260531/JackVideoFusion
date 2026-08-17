/**
 * 分割选项解析纯函数单测
 * 职责:验证界面选项(保留原画质/去原声/命名规则)到 ffmpeg 分割选项的映射,
 *       以及 segment 输出选项的生成
 * 运行:node --test --experimental-strip-types src/main/services/ffmpeg/__tests__/split-options.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSplitOpts, buildSegmentOutputOptions } from '../split-options.ts';

describe('resolveSplitOpts', () => {
  it('保留原画质时选择关键帧快速分割(precise=false)', () => {
    const opts = resolveSplitOpts({ keepQuality: true });
    assert.equal(opts.precise, false);
  });

  it('不保留原画质时选择精确重编码(precise=true)', () => {
    const opts = resolveSplitOpts({ keepQuality: false });
    assert.equal(opts.precise, true);
  });

  it('去原声透传到分割选项', () => {
    const opts = resolveSplitOpts({ stripAudio: true });
    assert.equal(opts.stripAudio, true);
  });

  it('默认不去原声', () => {
    const opts = resolveSplitOpts({});
    assert.equal(opts.stripAudio, false);
  });

  it('命名规则把 {index} 转为 %03d、{name} 替换为输入名', () => {
    const opts = resolveSplitOpts({
      namingRule: '{name}_{index}',
      inputName: 'clip',
    });
    assert.equal(opts.prefix, 'clip_');
  });

  it('命名规则未包含命名占位符时使用默认前缀', () => {
    const opts = resolveSplitOpts({ namingRule: '', inputName: 'clip' });
    assert.equal(opts.prefix, undefined);
  });
});

describe('buildSegmentOutputOptions', () => {
  it('快速复制模式默认加流复制与全流映射', () => {
    assert.deepEqual(buildSegmentOutputOptions({ precise: false }), [
      '-c',
      'copy',
      '-map',
      '0',
    ]);
  });

  it('精确重编码模式不加流复制', () => {
    assert.deepEqual(buildSegmentOutputOptions({ precise: true }), []);
  });

  it('去原声时追加 -an', () => {
    assert.deepEqual(buildSegmentOutputOptions({ precise: false, stripAudio: true }), [
      '-c',
      'copy',
      '-map',
      '0',
      '-an',
    ]);
  });
});
