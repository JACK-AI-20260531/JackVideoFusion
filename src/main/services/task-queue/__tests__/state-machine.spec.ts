/**
 * 状态机纯函数单测
 * 职责:覆盖所有合法状态转换与非法转换(抛错)用例
 * 运行:node --test --import tsx src/main/services/task-queue/__tests__/state-machine.spec.ts
 *       (或集成 vitest 后用 vitest 运行)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transition, isTerminal } from '../state-machine';
import type { TaskStatus } from '../../../../shared/types';
import type { TaskEvent } from '../types';

/**
 * 合法转换表:[当前状态, 事件, 期望目标状态]
 * 与 state-machine.ts 的 TRANSITIONS 表一一对应
 */
const LEGAL: Array<[TaskStatus, TaskEvent, TaskStatus]> = [
  ['pending', 'start', 'running'],
  ['pending', 'cancel', 'cancelled'],
  ['running', 'pause', 'paused'],
  ['running', 'complete', 'completed'],
  ['running', 'fail', 'failed'],
  ['running', 'cancel', 'cancelled'],
  ['paused', 'resume', 'running'],
  ['paused', 'cancel', 'cancelled'],
];

/** 全部状态枚举 */
const ALL_STATUS: TaskStatus[] = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

/** 全部事件枚举 */
const ALL_EVENTS: TaskEvent[] = [
  'start',
  'pause',
  'resume',
  'complete',
  'fail',
  'cancel',
];

describe('transition 合法状态转换', () => {
  for (const [from, event, to] of LEGAL) {
    it(`${from} --${event}--> ${to}`, () => {
      assert.equal(transition(from, event), to);
    });
  }
});

describe('transition 非法状态转换(应抛错)', () => {
  // 构造合法集合用于排除
  const legalSet = new Set(LEGAL.map(([f, e]) => `${f}:${e}`));
  for (const from of ALL_STATUS) {
    for (const event of ALL_EVENTS) {
      const key = `${from}:${event}`;
      if (legalSet.has(key)) continue;
      it(`${from} --${event}--> 抛错`, () => {
        assert.throws(() => transition(from, event), /非法状态转换/);
      });
    }
  }
});

describe('transition 终态不可再转换', () => {
  const terminalStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled'];
  for (const status of terminalStatuses) {
    for (const event of ALL_EVENTS) {
      it(`${status} --${event}--> 抛错`, () => {
        assert.throws(() => transition(status, event), /非法状态转换/);
      });
    }
  }
});

describe('isTerminal 终态判定', () => {
  it('completed/failed/cancelled 为终态', () => {
    assert.equal(isTerminal('completed'), true);
    assert.equal(isTerminal('failed'), true);
    assert.equal(isTerminal('cancelled'), true);
  });
  it('pending/running/paused 非终态', () => {
    assert.equal(isTerminal('pending'), false);
    assert.equal(isTerminal('running'), false);
    assert.equal(isTerminal('paused'), false);
  });
});
