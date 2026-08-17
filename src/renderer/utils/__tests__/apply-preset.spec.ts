/**
 * 模板套用到表单的纯函数单测
 * 职责:验证 applyPreset 安全地把模板业务参数覆盖到表单默认值(处理缺失/未知/类型不符键)
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/apply-preset.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset } from '../apply-preset.ts';

describe('applyPreset', () => {
  it('preset 中存在的键覆盖 fallback,缺失键保留 fallback 默认', () => {
    const fallback = { segmentSec: 10, keepQuality: true, stripAudio: false };
    const preset = { segmentSec: 30, keepQuality: false };
    const out = applyPreset(fallback, preset);
    assert.equal(out.segmentSec, 30);
    assert.equal(out.keepQuality, false);
    assert.equal(out.stripAudio, false);
  });

  it('preset 为 null/空时返回 fallback 的副本(不原地改)', () => {
    const fallback = { a: 1, b: 2 };
    const out = applyPreset(fallback, undefined);
    assert.deepEqual(out, { a: 1, b: 2 });
    out.a = 99;
    assert.equal(fallback.a, 1);
  });

  it('preset 中类型不符的键被忽略(用 fallback)', () => {
    const fallback = { segmentSec: 10, namingRule: false };
    const out = applyPreset(fallback, { segmentSec: 'abc', namingRule: 'yes' });
    assert.equal(out.segmentSec, 10);
    assert.equal(out.namingRule, false);
  });

  it('preset 数字字段为字符串数字时强转为 number 覆盖', () => {
    const fallback = { segmentSec: 10, keepQuality: true };
    const out = applyPreset(fallback, { segmentSec: '30' });
    assert.equal(out.segmentSec, 30);
    assert.equal(typeof out.segmentSec, 'number');
    assert.equal(out.keepQuality, true);
  });

  it('preset 数字字段为不可解析字符串时保留 fallback', () => {
    const fallback = { segmentSec: 10 };
    const out = applyPreset(fallback, { segmentSec: 'abc' });
    assert.equal(out.segmentSec, 10);
  });
});
