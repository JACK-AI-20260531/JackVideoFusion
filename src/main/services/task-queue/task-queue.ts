/**
 * 任务队列实现
 * 职责:维护任务列表、并发调度、状态转换、检查点持久化、进度推送
 *
 * 设计要点:
 *  - 默认并发数 1(避免磁盘/GPU 抢占),可通过 setConcurrency 调整
 *  - 任务列表持久化到 userData/task-queue/tasks.json,支持崩溃后恢复
 *  - 进度通过 BrowserWindow.webContents.send('task:progress', task) 推送
 *  - 启动恢复:restoreOnStartup 将所有 running 任务转为 paused
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import type { TaskItem, TaskEvent, Checkpoint, TaskQueue } from './types';
import { transition, isTerminal } from './state-machine';
import {
  saveCheckpoint,
  loadCheckpoint,
  removeCheckpoint,
} from './checkpoint-store';
import { logger } from '../../utils/logger';

/**
 * 获取任务列表持久化文件路径
 * 位于 userData/task-queue/tasks.json
 */
function tasksFile(): string {
  const dir = join(app.getPath('userData'), 'task-queue');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'tasks.json');
}

/**
 * 持久化任务列表到磁盘
 * @param tasks 当前所有任务
 */
function persistTasks(tasks: TaskItem[]): void {
  try {
    writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2), 'utf8');
  } catch (err) {
    logger.error(
      `[TaskQueue] 持久化任务列表失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 从磁盘加载持久化的任务列表
 * @returns 任务数组,加载失败返回空数组
 */
function loadPersistedTasks(): TaskItem[] {
  try {
    const fp = tasksFile();
    if (!existsSync(fp)) return [];
    const raw = readFileSync(fp, 'utf8');
    return JSON.parse(raw) as TaskItem[];
  } catch (err) {
    logger.error(
      `[TaskQueue] 加载持久化任务列表失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * 任务队列实现类(可注入依赖以便单测)
 * 通过单例 taskQueue 暴露,所有方法均为同步语义
 */
export interface TaskQueueDeps {
  /** 从磁盘加载持久化任务(默认读 userData/task-queue/tasks.json) */
  loadPersisted?: () => TaskItem[];
  /** 将任务列表持久化到磁盘 */
  persist?: (tasks: TaskItem[]) => void;
  /** 推送任务进度到渲染层 */
  emitProgress?: (task: TaskItem) => void;
  /** 保存检查点 */
  saveCheckpoint?: (taskId: string, step: string, progress: number, ctx: unknown) => void;
  /** 加载检查点 */
  loadCheckpoint?: (taskId: string) => Checkpoint | null;
  /** 移除检查点 */
  removeCheckpoint?: (taskId: string) => void;
  /** 当前时间(ISO 字符串) */
  now?: () => string;
}

/**
 * 任务队列实现类
 * 通过单例 taskQueue 暴露,所有方法均为同步语义
 */
export class TaskQueueImpl implements TaskQueue {
  /** 内存任务表:taskId → TaskItem */
  private tasks = new Map<string, TaskItem>();
  /** 最大并发执行数(默认 1) */
  private maxConcurrency = 1;
  /** 是否已从磁盘加载持久化任务(懒加载,避免模块加载时 app 未 ready) */
  private loaded = false;
  /** 注入的依赖 */
  private readonly deps: Required<TaskQueueDeps>;

  /**
   * @param deps 可选依赖注入(默认使用真实 electron/fs/checkpoint 实现)
   */
  constructor(deps: TaskQueueDeps = {}) {
    this.deps = {
      loadPersisted: deps.loadPersisted ?? loadPersistedTasks,
      persist: deps.persist ?? persistTasks,
      emitProgress: deps.emitProgress ?? ((task) => {
        // 默认实现:推送到主窗口
        const win = BrowserWindow.getAllWindows().length > 0 ? BrowserWindow.getAllWindows()[0] : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('task:progress', task);
        }
      }),
      saveCheckpoint: deps.saveCheckpoint ?? saveCheckpoint,
      loadCheckpoint: deps.loadCheckpoint ?? loadCheckpoint,
      removeCheckpoint: deps.removeCheckpoint ?? removeCheckpoint,
      now: deps.now ?? (() => new Date().toISOString()),
    };
  }

  /**
   * 懒加载持久化任务
   * 在首次访问( enqueue/list/get/restoreOnStartup )时触发
   * 避免模块加载阶段 app 尚未 ready 导致 getPath 抛错
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const persisted = this.deps.loadPersisted();
    for (const t of persisted) {
      if (!this.tasks.has(t.id)) this.tasks.set(t.id, t);
    }
  }

  /**
   * 推送任务进度到渲染层
   * channel: 'task:progress',payload: 完整 TaskItem
   */
  private emitProgress(task: TaskItem): void {
    this.deps.emitProgress(task);
  }

  /**
   * 触发任务列表持久化
   */
  private sync(): void {
    this.deps.persist([...this.tasks.values()]);
  }

  /**
   * 应用状态转换并更新任务字段
   * @returns 转换后的任务对象;任务不存在时抛错
   */
  private applyTransition(taskId: string, event: TaskEvent): TaskItem {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    const next = transition(task.status, event);
    task.status = next;
    // 首次进入 running 记录开始时间
    if (next === 'running' && !task.startedAt) {
      task.startedAt = this.deps.now();
    }
    // 进入终态记录结束时间
    if (isTerminal(next)) {
      task.finishedAt = this.deps.now();
    }
    this.emitProgress(task);
    this.sync();
    return task;
  }

  /**
   * 调度:在并发限制内将 pending 任务转为 running
   * 策略:按 createdAt 升序选取 pending 任务,直到占满并发槽
   */
  private schedule(): void {
    const runningCount = [...this.tasks.values()].filter(
      (t) => t.status === 'running',
    ).length;
    let slots = this.maxConcurrency - runningCount;
    if (slots <= 0) return;

    const pending = [...this.tasks.values()]
      .filter((t) => t.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const task of pending) {
      if (slots <= 0) break;
      try {
        this.applyTransition(task.id, 'start');
        slots--;
      } catch (err) {
        logger.warn(
          `[TaskQueue] 调度任务 ${task.id} 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * 入队任务
   * 强制 status=pending/progress=0,自动触发调度
   * @returns 任务 ID(若传入无 id 则生成 UUID)
   */
  enqueue(task: TaskItem): string {
    this.ensureLoaded();
    const id = task.id || randomUUID();
    const now = this.deps.now();
    const item: TaskItem = {
      ...task,
      id,
      status: 'pending',
      progress: 0,
      createdAt: task.createdAt || now,
    };
    this.tasks.set(id, item);
    this.emitProgress(item);
    this.sync();
    this.schedule();
    return id;
  }

  /**
   * 暂停任务(running → paused)
   */
  pause(taskId: string): void {
    this.ensureLoaded();
    this.applyTransition(taskId, 'pause');
  }

  /**
   * 恢复任务
   *  - paused → running(经状态机),随后重新调度
   *  - pending 直接尝试调度
   */
  resume(taskId: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status === 'paused') {
      this.applyTransition(taskId, 'resume');
      this.schedule();
    } else if (task.status === 'pending') {
      this.schedule();
    }
  }

  /**
   * 取消任务(多源 → cancelled)
   * 取消后清理检查点并触发调度推进后续任务
   */
  cancel(taskId: string): void {
    this.ensureLoaded();
    this.applyTransition(taskId, 'cancel');
    this.deps.removeCheckpoint(taskId);
    this.schedule();
  }

  /**
   * 标记任务完成(running → completed)
   * @param output 可选输出路径
   */
  complete(taskId: string, output?: string): void {
    this.ensureLoaded();
    const task = this.applyTransition(taskId, 'complete');
    if (output !== undefined) task.output = output;
    this.deps.removeCheckpoint(taskId);
    this.schedule();
  }

  /**
   * 标记任务失败(running → failed)
   * @param error 失败原因
   */
  fail(taskId: string, error: string): void {
    this.ensureLoaded();
    const task = this.applyTransition(taskId, 'fail');
    task.error = error;
    this.deps.removeCheckpoint(taskId);
    this.schedule();
  }

  /**
   * 更新任务进度(执行者在原子步骤间调用)
   * @param progress 0-100,越界自动钳制
   */
  updateProgress(taskId: string, progress: number): void {
    this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.progress = Math.max(0, Math.min(100, progress));
    this.emitProgress(task);
    this.sync();
  }

  /**
   * 列出所有任务(按 createdAt 升序)
   */
  list(): TaskItem[] {
    this.ensureLoaded();
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  /**
   * 获取单个任务
   */
  get(taskId: string): TaskItem | null {
    this.ensureLoaded();
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * 保存检查点(委托 checkpoint-store),并同步进度到任务
   */
  saveCheckpoint(taskId: string, step: string, progress: number, ctx: unknown): void {
    this.ensureLoaded();
    this.deps.saveCheckpoint(taskId, step, progress, ctx);
    this.updateProgress(taskId, progress);
  }

  /**
   * 加载检查点
   */
  loadCheckpoint(taskId: string): Checkpoint | null {
    this.ensureLoaded();
    return this.deps.loadCheckpoint(taskId);
  }

  /**
   * 设置最大并发数(最小 1)
   * 调整后立即触发调度
   */
  setConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(n));
    this.schedule();
  }

  /**
   * 启动恢复:将所有 running 任务转为 paused(进程崩溃兜底)
   * 应在 app.whenReady 时调用(本模块 register 时自动触发一次)
   */
  restoreOnStartup(): void {
    this.ensureLoaded();
    let restored = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.status = 'paused';
        this.emitProgress(task);
        restored++;
      }
    }
    if (restored > 0) {
      logger.info(`[TaskQueue] 启动恢复: ${restored} 个 running 任务转为 paused`);
      this.sync();
    }
  }
}

/**
 * 任务队列单例
 * 全局共享,主进程各服务通过此实例入队/查询/控制任务
 */
export const taskQueue: TaskQueue = new TaskQueueImpl();
