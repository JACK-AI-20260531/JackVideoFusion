/**
 * 自动流水线 IPC 注册(PRD-v2.1 FR-2/3)
 * 职责:将 pipelineStore/executePipeline/pipelineScheduler 暴露为 pipeline:* 通道
 *
 * 通道列表:
 *   pipeline:save          - 新增/更新管线(逐字段校验)
 *   pipeline:list          - 全量列表
 *   pipeline:get           - 查询单条
 *   pipeline:delete        - 删除
 *   pipeline:run           - 触发执行(异步,进度见任务中心)
 *   pipeline:startScheduler - 启动定时轮询
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { pipelineStore } from '../services/pipeline/store';
import { validateSchedule, validateSteps } from '../services/pipeline/validate';
import {
  executePipeline,
  pipelineScheduler,
} from '../services/pipeline/index';
import type { Pipeline } from '../services/pipeline/types';

/**
 * 注册自动流水线 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 新增或更新流水线
   * payload: Partial<Pipeline>(含 name/steps/schedule/scheduleEnabled)
   * 返回: Pipeline
   */
  safeHandle(ipc, 'pipeline:save', async (_event, payload) => {
    const p = payload as Partial<Pipeline> | undefined;
    if (!p?.name || typeof p.name !== 'string') throw new Error('pipeline:save 缺少 name');
    const stepsErr = validateSteps(p.steps ?? []);
    if (stepsErr) throw new Error(`pipeline:save 参数无效:${stepsErr}`);
    const scheduleErr = validateSchedule(p.schedule);
    if (scheduleErr) throw new Error(`pipeline:save 参数无效:${scheduleErr}`);
    const now = new Date().toISOString();
    const existing = p.id ? pipelineStore.get(p.id) : null;
    const pipeline: Pipeline = {
      id: existing?.id ?? `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: p.name,
      steps: p.steps!,
      schedule: p.schedule,
      scheduleEnabled: p.scheduleEnabled ?? false,
      lastRunAt: existing?.lastRunAt,
      lastRun: existing?.lastRun,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    pipelineStore.upsert(pipeline);
    return pipeline;
  });

  /** 全量列表(按更新时间降序) */
  safeHandle(ipc, 'pipeline:list', async () => pipelineStore.list());

  /** 查询单条 */
  safeHandle(ipc, 'pipeline:get', async (_event, payload) => {
    const p = payload as { id?: string } | undefined;
    if (!p?.id) throw new Error('pipeline:get 缺少 id');
    return pipelineStore.get(p.id);
  });

  /** 删除 */
  safeHandle(ipc, 'pipeline:delete', async (_event, payload) => {
    const p = payload as { id?: string } | undefined;
    if (!p?.id) throw new Error('pipeline:delete 缺少 id');
    return pipelineStore.remove(p.id);
  });

  /**
   * 运行流水线(异步启动,三结局在 executePipeline 内处理)
   * payload: { id: string }
   * 返回: { started: id }
   */
  safeHandle(ipc, 'pipeline:run', async (_event, payload) => {
    const p = payload as { id?: string } | undefined;
    if (!p?.id) throw new Error('pipeline:run 缺少 id');
    const pipeline = pipelineStore.get(p.id);
    if (!pipeline) throw new Error(`pipeline:run 流水线不存在: ${p.id}`);
    void executePipeline(pipeline).catch(() => {
      /* 三结局已在 executePipeline 内处理,这里吞掉异步异常避免未捕获 */
    });
    return { started: p.id };
  });

  /** 启动定时轮询(应用生命周期内幂等) */
  safeHandle(ipc, 'pipeline:startScheduler', async () => {
    pipelineScheduler.start();
    return { started: true };
  });
}
