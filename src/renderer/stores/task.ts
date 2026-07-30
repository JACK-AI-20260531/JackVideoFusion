/**
 * 任务队列状态仓库
 * 职责:维护任务列表、当前执行任务、进度
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { TaskStatus, TaskType } from '@shared/types';

// 任务条目结构
export interface TaskItem {
  id: string;
  type: TaskType;
  title: string;
  status: TaskStatus;
  progress: number;       // 0-100
  params: Record<string, unknown>;
  output?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export const useTaskStore = defineStore('task', () => {
  // 任务队列
  const tasks = ref<TaskItem[]>([]);
  // 当前执行中的任务 ID
  const runningTaskId = ref<string | null>(null);

  // 排队中的任务数
  const pendingCount = computed(() =>
    tasks.value.filter((t) => t.status === 'pending').length,
  );
  // 当前执行中的任务
  const runningTask = computed(() =>
    tasks.value.find((t) => t.id === runningTaskId.value) ?? null,
  );

  // 入队任务
  function enqueue(task: TaskItem): void {
    tasks.value.push(task);
  }
  // 更新任务状态/进度
  function updateTask(id: string, patch: Partial<TaskItem>): void {
    const idx = tasks.value.findIndex((t) => t.id === id);
    if (idx >= 0) tasks.value[idx] = { ...tasks.value[idx], ...patch };
  }
  // 移除任务
  function removeTask(id: string): void {
    tasks.value = tasks.value.filter((t) => t.id !== id);
  }

  return { tasks, runningTaskId, pendingCount, runningTask, enqueue, updateTask, removeTask };
});
