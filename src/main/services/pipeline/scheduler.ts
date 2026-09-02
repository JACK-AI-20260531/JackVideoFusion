/**
 * 流水线定时调度(PRD-v2.1 FR-3)
 * 职责:isPipelineDue 纯函数判定到期;PipelineScheduler 轮询触发到点管线
 * 设计要点:
 *  - 到期判定纯函数可测;调度器只做"到期 → 触发"编排,单条失败静默记日志不影响其余
 *  - 轮询间隔默认 60s;runner 注入(默认 wiring 见 index.ts)
 */
import { logger } from '../../utils/logger';
import type { Pipeline, PipelineRunState, PipelineSchedule } from './types';

/**
 * 判定管线是否到期应触发
 * @param schedule 定时配置
 * @param lastRunAt 最近运行时间(ISO,undefined=从未运行)
 * @param now 当前时间戳(毫秒)
 */
export function isPipelineDue(
  schedule: PipelineSchedule,
  lastRunAt: string | undefined,
  now: number,
): boolean {
  if (!/^\d{2}:\d{2}$/.test(schedule.at)) return false;
  const [hh, mm] = schedule.at.split(':').map(Number);
  if (hh > 23 || mm > 59) return false;
  const d = new Date(now);
  if (schedule.kind === 'weekly' && d.getDay() !== schedule.weekday) return false;
  const dueAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
  if (now < dueAt) return false;
  // once:从未跑过才触发
  if (schedule.kind === 'once' && lastRunAt) return false;
  // 本轮触发点之后已跑过则不再触发
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt).getTime();
  return last < dueAt;
}

/** PipelineScheduler 依赖注入 */
export interface PipelineSchedulerDeps {
  /** 流水线存储(需要 list/setRun) */
  store: { list: () => Pipeline[]; setRun: (id: string, run: PipelineRunState) => boolean };
  /** 触发执行回调(默认 wiring 由 index.ts 注入) */
  runner: (pipeline: Pipeline) => Promise<void>;
  /** 轮询间隔毫秒(默认 60s) */
  checkIntervalMs?: number;
}

/** 流水线定时调度器:固定间隔轮询到期条目 */
export class PipelineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly store: PipelineSchedulerDeps['store'];
  private readonly runner: PipelineSchedulerDeps['runner'];
  private readonly checkIntervalMs: number;

  constructor(deps: PipelineSchedulerDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.checkIntervalMs = deps.checkIntervalMs ?? 60 * 1000;
  }

  /** 启动轮询(幂等) */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  /** 停止轮询 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 执行一轮到期检查
   * @param now 当前时间戳(毫秒,测试注入)
   * @returns 触发的管线数
   */
  async runOnce(now: number = Date.now()): Promise<number> {
    let fired = 0;
    for (const p of this.store.list()) {
      if (!p.schedule || !p.scheduleEnabled) continue;
      if (!isPipelineDue(p.schedule, p.lastRunAt, now)) continue;
      try {
        await this.runner(p);
      } catch (err) {
        logger.warn(
          `[pipeline-scheduler] 触发 ${p.name} 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      fired++;
    }
    return fired;
  }
}
