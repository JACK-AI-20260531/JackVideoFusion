/**
 * 任务队列存储 - electron-store 实现
 * 职责:基于 electron-store(JSON 持久化)实现 ITaskStore 接口
 *       供 Task 005(任务调度服务)调用,实现任务队列的崩溃恢复
 *
 * 注意:electron-store v10 为 ESM-only 模块,在 CommonJS 编译目标下
 *       必须使用动态 import() 加载,故所有方法设计为异步。
 */
import { app } from 'electron';
import { join } from 'path';
import { logger } from '../../utils/logger';
import type { ITaskStore, TaskListFilter, TaskRecord } from './types';

// electron-store v10 为 ESM-only,类型在 CJS 下不兼容,定义本地接口绕过
type AnyStore = {
  get(key: string): any;
  set(key: string, value: unknown): void;
};

/**
 * 获取 userData 目录(防御性:app 未就绪时回退到 cwd)
 * @returns userData 绝对路径
 */
function getUserDataDir(): string {
  return app?.getPath?.('userData') ?? process.cwd();
}

/**
 * 获取任务数据目录:userData/data/
 * @returns 数据目录绝对路径
 */
function getDataDir(): string {
  return join(getUserDataDir(), 'data');
}

/**
 * 获取当前时间的 ISO 8601 字符串
 * @returns ISO 时间戳
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * electron-store 构造器的懒加载器(ESM 动态导入)
 * 缓存 Promise 避免重复加载
 */
let storeCtorPromise: Promise<new (opts: unknown) => unknown> | null = null;

/**
 * 获取 electron-store 构造器(单例)
 * @returns Store 类构造器
 */
async function getStoreCtor(): Promise<new (opts: unknown) => unknown> {
  if (storeCtorPromise === null) {
    storeCtorPromise = import('electron-store').then((mod) => mod.default);
  }
  return storeCtorPromise;
}

/**
 * 基于 electron-store 的任务存储实现
 * 所有任务记录保存在单个 JSON 文件中(userData/data/tasks.json)
 */
export class ElectronStoreTaskStore implements ITaskStore {
  /** store 实例(懒加载) */
  private store: AnyStore | null = null;

  /**
   * 获取 store 实例(首次调用时创建)
   * @returns tasks store 实例
   */
  private async getStore(): Promise<AnyStore> {
    if (this.store === null) {
      const StoreCtor = await getStoreCtor();
      this.store = new StoreCtor({
        name: 'tasks',
        cwd: getDataDir(),
        defaults: { tasks: {} },
      }) as AnyStore;
      logger.info('[TaskStore] 任务存储 store 已初始化');
    }
    return this.store;
  }

  /**
   * 保存(或覆盖)一条任务记录
   * @param task 任务记录
   */
  async saveTask(task: TaskRecord): Promise<void> {
    const store = await this.getStore();
    const tasks = store.get('tasks');
    tasks[task.id] = { ...task, updatedAt: now() };
    store.set('tasks', tasks);
  }

  /**
   * 增量更新任务记录
   * @param id 任务 ID
   * @param patch 待更新的字段
   * @returns 更新后的完整记录;若 id 不存在返回 null
   */
  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null> {
    const store = await this.getStore();
    const tasks = store.get('tasks');
    const existing = tasks[id];
    if (!existing) {
      return null;
    }
    const updated: TaskRecord = { ...existing, ...patch, id: existing.id, updatedAt: now() };
    tasks[id] = updated;
    store.set('tasks', tasks);
    return updated;
  }

  /**
   * 获取单条任务记录
   * @param id 任务 ID
   * @returns 任务记录;不存在返回 null
   */
  async getTask(id: string): Promise<TaskRecord | null> {
    const store = await this.getStore();
    const tasks = store.get('tasks');
    return tasks[id] ?? null;
  }

  /**
   * 列出任务记录(支持过滤)
   * @param filter 过滤条件(状态 / 类型)
   * @returns 任务记录数组(按创建时间升序)
   */
  async listTasks(filter?: TaskListFilter): Promise<TaskRecord[]> {
    const store = await this.getStore();
    const tasks = store.get('tasks') as Record<string, TaskRecord>;
    let result: TaskRecord[] = Object.values(tasks);
    if (filter?.status) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.type) {
      result = result.filter((t) => t.type === filter.type);
    }
    return result.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  /**
   * 删除一条任务记录
   * @param id 任务 ID
   * @returns 是否删除成功
   */
  async deleteTask(id: string): Promise<boolean> {
    const store = await this.getStore();
    const tasks = store.get('tasks');
    if (!tasks[id]) {
      return false;
    }
    delete tasks[id];
    store.set('tasks', tasks);
    return true;
  }

  /**
   * 清空所有任务记录
   */
  async clearAll(): Promise<void> {
    const store = await this.getStore();
    store.set('tasks', {});
    logger.info('[TaskStore] 所有任务记录已清空');
  }
}
