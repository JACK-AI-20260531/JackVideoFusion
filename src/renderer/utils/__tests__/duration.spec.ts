/**
 * 时长格式化纯函数单测
 * 职责:验证把秒数格式化为可读时长(mm:ss / h:mm:ss)
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/duration.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDurationSec } from '../duration.ts';

describe('formatDurationSec', () => {
  it('不足一秒归零', () => {
    assert.equal(formatDurationSec(0), '0:00');
    assert.equal(formatDurationSec(0.4), '0:00');
  });

  it('一分内显示 m:ss', () => {
    assert.equal(formatDurationSec(5), '0:05');
    assert.equal(formatDurationSec(59.6), '1:00');
  });

  it('超过一分显示 mm:ss', () => {
    assert.equal(formatDurationSec(65), '1:05');
    assert.equal(formatDurationSec(90), '1:30');
  });

  it('超过一小时显示 h:mm:ss', () => {
    assert.equal(formatDurationSec(3600), '1:00:00');
    assert.equal(formatDurationSec(3661), '1:01:01');
  });

  it('负数与非法输入归零', () => {
    assert.equal(formatDurationSec(-3), '0:00');
    assert.equal(formatDurationSec(Number.NaN), '0:00');
  });
});
