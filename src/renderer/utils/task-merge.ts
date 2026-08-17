/**
 * 任务列表合并纯函数
 * 职责:将主进程 taskQueue 的任务合并进渲染层任务列表
 * 规则:按 id 去重,已存在的任务用新值覆盖 status/progress/output/error/finishedAt 等字段
 */
import type { TaskItem } from '../stores/task';

/**
 * 合并两个任务列表(以 incoming 为准,按 id 匹配更新)
 * @param existing 渲染层现有任务列表
 * @param incoming 主进程拉取/推送的任务列表
 * @returns 合并后的新任务列表(不修改入参数组)
 */
export function mergeTaskLists(existing: TaskItem[], incoming: TaskItem[]): TaskItem[] {
  const byId = new Map<string, TaskItem>();
  for (const task of existing) {
    byId.set(task.id, task);
  }
  for (const task of incoming) {
    const prev = byId.get(task.id);
    byId.set(task.id, prev ? { ...prev, ...task } : { ...task });
  }
  return Array.from(byId.values());
}
