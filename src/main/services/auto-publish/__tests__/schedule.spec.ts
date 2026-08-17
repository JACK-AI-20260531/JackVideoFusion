/**
 * 定时发布调度纯函数单测
 * 职责:验证 computeScheduleDelayMs 对 scheduledAt 的延迟计算(空/非法/过去/未来)
 *      不依赖 electron,可独立单元测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/schedule.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeScheduleDelayMs } from '../schedule.ts';

describe('computeScheduleDelayMs', () => {
  before(() => {
    // 固定系统时间,保证测试确定性
    globalThis.__CLOCK__ = Date.now;
    const fixed = new Date('2026-01-01T00:00:00Z').getTime();
    Date.now = () => fixed;
  });

  after(() => {
    Date.now = globalThis.__CLOCK__;
    delete globalThis.__CLOCK__;
  });

  const FIXED = new Date('2026-01-01T00:00:00Z').getTime();

  it('空或空白 scheduledAt 返回 null(立即执行)', () => {
    assert.equal(computeScheduleDelayMs(undefined), null);
    assert.equal(computeScheduleDelayMs(''), null);
    assert.equal(computeScheduleDelayMs('   '), null);
  });

  it('非法日期字符串返回 null', () => {
    assert.equal(computeScheduleDelayMs('not-a-date'), null);
    assert.equal(computeScheduleDelayMs('abc'), null);
  });

  it('已过去的 scheduledAt 返回 null(立即执行)', () => {
    assert.equal(computeScheduleDelayMs(new Date(FIXED - 1000).toISOString()), null);
  });

  it('未来的 scheduledAt 返回正值延迟', () => {
    const delay = computeScheduleDelayMs(new Date(FIXED + 5000).toISOString());
    assert.ok(delay !== null && delay > 0 && Math.abs(delay - 5000) < 1000);
  });

  it('恰好当前时刻视为立即(非未来)', () => {
    assert.equal(computeScheduleDelayMs(new Date(FIXED).toISOString()), null);
  });
});
