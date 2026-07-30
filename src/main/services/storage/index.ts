/**
 * 任务队列存储模块入口
 * 职责:导出 ITaskStore 接口、electron-store 实现与单例
 *       供 Task 005(任务调度服务)通过 ITaskStore 接口调用
 */
export type { ITaskStore, TaskRecord, TaskListFilter } from './types';
export { ElectronStoreTaskStore } from './task-store';

import { ElectronStoreTaskStore } from './task-store';
import type { ITaskStore } from './types';

/** 单例实例(懒加载) */
let taskStoreInstance: ITaskStore | null = null;

/**
 * 获取任务存储单例(基于 electron-store)
 * 首次调用时创建实例;Store 实例在首次访问时才初始化(app ready 后)
 * @returns ITaskStore 单例
 */
export function getTaskStore(): ITaskStore {
  if (taskStoreInstance === null) {
    taskStoreInstance = new ElectronStoreTaskStore();
  }
  return taskStoreInstance;
}
