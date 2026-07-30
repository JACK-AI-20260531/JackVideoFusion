/**
 * 任务队列 IPC 注册
 * 职责:注册 task:* 系列 handlers,桥接渲染层与 taskQueue 单例
 *
 * channel 清单:
 *  - task:enqueue        入队任务
 *  - task:pause          暂停任务
 *  - task:resume         恢复任务
 *  - task:cancel         取消任务
 *  - task:list           列出所有任务
 *  - task:get            获取单个任务
 *  - task:complete       标记任务完成(执行者调用)
 *  - task:fail           标记任务失败(执行者调用)
 *  - task:updateProgress 更新任务进度(执行者调用)
 *
 * 进度推送 channel: 'task:progress'(由 taskQueue 主动 send,非 handle)
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import { logger } from '../utils/logger';

/**
 * 注册任务队列相关 IPC handlers
 * 在注册完成后执行一次启动恢复(将 running 任务转为 paused)
 * @param ipc ipcMain 引用
 */
export function register(ipc: typeof ipcMain): void {
  // 入队任务:payload 为 TaskItem(无需预填 id/status/progress)
  safeHandle(ipc, 'task:enqueue', (_event: IpcMainInvokeEvent, payload: unknown): string => {
    const task = payload as TaskItem;
    return taskQueue.enqueue(task);
  });

  // 暂停任务:payload 为 taskId
  safeHandle(ipc, 'task:pause', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    taskQueue.pause(payload as string);
  });

  // 恢复任务:payload 为 taskId
  safeHandle(ipc, 'task:resume', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    taskQueue.resume(payload as string);
  });

  // 取消任务:payload 为 taskId
  safeHandle(ipc, 'task:cancel', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    taskQueue.cancel(payload as string);
  });

  // 列出所有任务
  safeHandle(ipc, 'task:list', (): TaskItem[] => {
    return taskQueue.list();
  });

  // 获取单个任务:payload 为 taskId
  safeHandle(ipc, 'task:get', (_event: IpcMainInvokeEvent, payload: unknown): TaskItem | null => {
    return taskQueue.get(payload as string);
  });

  // 标记任务完成:payload 为 { taskId, output? }
  safeHandle(ipc, 'task:complete', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    const { taskId, output } = payload as { taskId: string; output?: string };
    taskQueue.complete(taskId, output);
  });

  // 标记任务失败:payload 为 { taskId, error }
  safeHandle(ipc, 'task:fail', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    const { taskId, error } = payload as { taskId: string; error: string };
    taskQueue.fail(taskId, error);
  });

  // 更新任务进度:payload 为 { taskId, progress }
  safeHandle(ipc, 'task:updateProgress', (_event: IpcMainInvokeEvent, payload: unknown): void => {
    const { taskId, progress } = payload as { taskId: string; progress: number };
    taskQueue.updateProgress(taskId, progress);
  });

  // 启动恢复:将所有 running 任务转为 paused(进程崩溃兜底)
  taskQueue.restoreOnStartup();

  logger.info('[IPC] task:* handlers 已注册');
}
