/**
 * 任务状态机(纯函数实现)
 * 职责:定义合法状态转换表,提供 transition 纯函数
 * 设计目标:无副作用、易测试、可被队列与执行者复用
 */
import type { TaskStatus } from '../../../shared/types';
import type { TaskEvent } from './types';

/**
 * 合法状态转换映射表
 * key 格式: `${current}:${event}`
 * value: 目标状态
 *
 * 状态流: pending → running → paused → completed | failed | cancelled
 *  - pending 可被 start(开始执行)或 cancel(取消排队)
 *  - running 可被 pause/complete/fail/cancel
 *  - paused 可被 resume(恢复执行)或 cancel
 *  - completed/failed/cancelled 为终态,不接受任何事件
 */
const TRANSITIONS: Record<string, TaskStatus> = {
  'pending:start': 'running',
  'pending:cancel': 'cancelled',
  'running:pause': 'paused',
  'running:complete': 'completed',
  'running:fail': 'failed',
  'running:cancel': 'cancelled',
  'paused:resume': 'running',
  'paused:cancel': 'cancelled',
};

/**
 * 状态机纯函数:根据当前状态与事件计算下一状态
 * @param current 当前任务状态
 * @param event   触发事件
 * @returns 转换后的新状态
 * @throws Error 当状态+事件组合非法时抛出(便于调用方捕获并诊断)
 */
export function transition(current: TaskStatus, event: TaskEvent): TaskStatus {
  const key = `${current}:${event}`;
  const next = TRANSITIONS[key];
  if (!next) {
    throw new Error(`非法状态转换: ${current} --${event}-->`);
  }
  return next;
}

/**
 * 判断状态是否为终态(不可再转换)
 * @param status 任务状态
 * @returns completed/failed/cancelled 返回 true,其余 false
 */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
