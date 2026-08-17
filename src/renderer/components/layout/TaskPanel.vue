<script setup lang="ts">
/**
 * 任务列表面板
 * 职责:展示当前运行中/排队/已完成的任务,支持取消排队任务
 * 性能:按状态分组,限制已完成任务展示数量
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useTaskStore, type TaskItem } from '../../stores/task';
import type { TaskStatus, TaskType } from '@shared/types';

// 任务仓库
const taskStore = useTaskStore();

// 面板是否展开
const expanded = ref(true);
// 最大展示的已完成任务数(性能保护)
const MAX_HISTORY = 20;

// 任务类型映射为中文标签
const taskTypeLabels: Record<TaskType, string> = {
  'material-split': '素材分割',
  'text-split': '文本分割',
  'subtitle-extract': '字幕提取',
  'tts-synthesize': 'TTS合成',
  'video-mix-random': '随机混剪',
  'video-mix-audio': '音频匹配',
  'ai-edit': 'AI剪辑',
  'ai-slice': 'AI切片',
  'film-dub-clone': '影视解说克隆',
  'voice-clone-synthesize': '语音克隆',
  'auto-publish': '自动发布',
};

// 任务状态对应的颜色
const statusColors: Record<TaskStatus, string> = {
  pending: 'var(--color-text-tertiary)',
  running: 'var(--color-accent)',
  paused: 'var(--color-warning)',
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
  cancelled: 'var(--color-text-tertiary)',
};

// 任务状态对应的中文标签
const statusLabels: Record<TaskStatus, string> = {
  pending: '排队中',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * 任务类型显示名
 */
function getTaskTypeLabel(type: TaskType): string {
  return taskTypeLabels[type] ?? type;
}

// 运行中的任务(单个)
const runningTask = computed(() =>
  taskStore.tasks.find((t) => t.status === 'running') ?? null,
);

// 排队中的任务(按创建时间排序)
const pendingTasks = computed(() =>
  taskStore.tasks
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);

// 已完成的任务(最近N条)
const finishedTasks = computed(() =>
  taskStore.tasks
    .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))
    .slice(0, MAX_HISTORY),
);

// 总任务数
const totalCount = computed(() => taskStore.tasks.length);

// 切换面板展开
function toggle(): void {
  expanded.value = !expanded.value;
}

// 清空已完成任务
function handleClearFinished(): void {
  const finishedIds = taskStore.tasks
    .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    .map((t) => t.id);
  finishedIds.forEach((id) => taskStore.removeTask(id));
}

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 从 window 安全获取 api
 */
function getApi(): { invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>> } {
  return (window as unknown as { api: { invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>> } }).api;
}

/**
 * 取消排队中的任务
 */
async function handleCancelTask(taskId: string): Promise<void> {
  try {
    await getApi().invoke<{ taskId: string }, void>('task:cancel', { taskId });
  } catch {
    /* IPC 未就绪时静默降级 */
  }
  taskStore.removeTask(taskId);
}

// 取消订阅的函数引用(挂载时记录,卸载时调用)
let unsubscribeTask: (() => void) | null = null;
let unsubscribeProgress: (() => void) | null = null;

// 挂载时订阅主进程任务事件
onMounted(async () => {
  // 拉取主进程 taskQueue 的全部任务并合并进渲染层任务列表(覆盖各业务模块任务)
  try {
    const res = await getApi().invoke<unknown, TaskItem[]>('task:list');
    if (res.ok && Array.isArray(res.data)) {
      taskStore.mergeTasks(res.data);
    }
  } catch {
    /* IPC 未就绪时静默降级 */
  }

  const api = (window as unknown as { api?: { on?: (ch: string, fn: (...args: unknown[]) => void) => () => void } }).api;
  if (!api?.on) return;

  // 订阅任务状态变更
  unsubscribeTask = api.on('task:update', (payload: unknown) => {
    const p = payload as { id: string; patch?: Record<string, unknown> } | undefined;
    if (p?.id && p.patch) {
      taskStore.updateTask(p.id, p.patch as Partial<typeof taskStore.tasks[0]>);
    }
  });

  // 订阅任务进度变更
  unsubscribeProgress = api.on('task:progress', (payload: unknown) => {
    const p = payload as { taskId: string; progress: number } | undefined;
    if (p?.taskId && typeof p.progress === 'number') {
      taskStore.updateTask(p.taskId, { progress: p.progress });
    }
  });
});

// 卸载时取消订阅
onUnmounted(() => {
  unsubscribeTask?.();
  unsubscribeProgress?.();
});
</script>

<template>
  <div class="task-panel" :class="{ 'task-panel--collapsed': !expanded }">
    <!-- 头部 -->
    <div class="task-panel__header" @click="toggle">
      <div class="task-panel__title-wrap">
        <span class="task-panel__title">任务队列</span>
        <span class="task-panel__count" v-if="totalCount > 0">{{ totalCount }}</span>
      </div>
      <span class="task-panel__toggle">{{ expanded ? '▾' : '▴' }}</span>
    </div>

    <div v-show="expanded" class="task-panel__body">
      <!-- 运行中 -->
      <div v-if="runningTask" class="task-panel__section">
        <div class="task-panel__section-title">
          <span class="task-panel__dot task-panel__dot--running" />
          运行中
        </div>
        <div class="task-panel__item task-panel__item--running">
          <div class="task-panel__item-main">
            <span class="task-panel__item-type">{{ getTaskTypeLabel(runningTask.type) }}</span>
            <span class="task-panel__item-title">{{ runningTask.title }}</span>
          </div>
          <div class="task-panel__item-meta">
            <span class="task-panel__progress">
              <span
                class="task-panel__progress-bar"
                :style="{ width: `${runningTask.progress}%` }"
              />
            </span>
            <span class="task-panel__progress-text">{{ runningTask.progress }}%</span>
          </div>
        </div>
      </div>

      <!-- 排队中 -->
      <div v-if="pendingTasks.length > 0" class="task-panel__section">
        <div class="task-panel__section-title">
          <span class="task-panel__dot task-panel__dot--pending" />
          排队中 ({{ pendingTasks.length }})
        </div>
        <div class="task-panel__list">
          <div v-for="task in pendingTasks" :key="task.id" class="task-panel__item">
            <div class="task-panel__item-main">
              <span class="task-panel__item-type">{{ getTaskTypeLabel(task.type) }}</span>
              <span class="task-panel__item-title">{{ task.title }}</span>
            </div>
            <button
              class="task-panel__cancel"
              title="取消"
              @click.stop="handleCancelTask(task.id)"
            >
              取消
            </button>
          </div>
        </div>
      </div>

      <!-- 已完成 -->
      <div v-if="finishedTasks.length > 0" class="task-panel__section">
        <div class="task-panel__section-title task-panel__section-title--with-action">
          <span>
            <span class="task-panel__dot task-panel__dot--finished" />
            已完成 ({{ finishedTasks.length }})
          </span>
          <button class="task-panel__clear" @click="handleClearFinished">清空</button>
        </div>
        <div class="task-panel__list">
          <div
            v-for="task in finishedTasks"
            :key="task.id"
            class="task-panel__item task-panel__item--finished"
          >
            <div class="task-panel__item-main">
              <span class="task-panel__item-type">{{ getTaskTypeLabel(task.type) }}</span>
              <span class="task-panel__item-title">{{ task.title }}</span>
              <span class="task-panel__item-status" :style="{ color: statusColors[task.status] }">
                {{ statusLabels[task.status] }}
              </span>
            </div>
            <div v-if="task.output" class="task-panel__item-output" :title="task.output">
              {{ task.output }}
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="totalCount === 0" class="task-panel__empty">
        暂无任务
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.task-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-elevated);

  &--collapsed {
    .task-panel__body { display: none; }
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 16px;
    cursor: pointer;
    user-select: none;

    &:hover { background: var(--color-bg-hover); }
  }

  &__title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__title {
    font-size: 12px;
    color: var(--color-text-tertiary);
    letter-spacing: 0.5px;
  }

  &__count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    background: var(--color-accent-soft);
    color: var(--color-accent);
    border-radius: 9px;
    font-size: 10px;
    font-weight: 600;
  }

  &__toggle {
    font-size: 10px;
    color: var(--color-text-tertiary);
  }

  &__body {
    max-height: 200px;
    overflow-y: auto;
    padding: 4px 12px 12px;
  }

  &__section {
    margin-top: 8px;

    &:first-child { margin-top: 4px; }
  }

  &__section-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-tertiary);
    margin: 0 0 4px;

    &--with-action {
      justify-content: space-between;
    }
  }

  &__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;

    &--running { background: var(--color-accent); animation: pulse 1.2s ease-in-out infinite; }
    &--pending { background: var(--color-text-tertiary); }
    &--finished { background: var(--color-success); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;

    &--running {
      background: var(--color-accent-soft);
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
    }

    &--finished {
      flex-direction: column;
      align-items: stretch;
      color: var(--color-text-tertiary);
    }

    &:hover { background: var(--color-bg-hover); }
  }

  &__item-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
  }

  &__item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__item-type {
    flex-shrink: 0;
    padding: 1px 6px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-subtle);
    border-radius: 3px;
    font-size: 10px;
    color: var(--color-text-tertiary);
  }

  &__item-title {
    flex: 1;
    min-width: 0;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__item-status {
    flex-shrink: 0;
    font-size: 10px;
  }

  &__item-output {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-disabled);
    font-size: 10px;
    line-height: 1.4;
  }

  &__progress {
    flex: 1;
    height: 4px;
    background: var(--color-bg-sunken);
    border-radius: 2px;
    overflow: hidden;
  }

  &__progress-bar {
    display: block;
    height: 100%;
    background: var(--color-accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  &__progress-text {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--color-accent);
    min-width: 32px;
    text-align: right;
  }

  &__cancel {
    flex-shrink: 0;
    padding: 1px 6px;
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    border-radius: 3px;
    color: var(--color-text-tertiary);
    font-size: 10px;
    cursor: pointer;

    &:hover {
      color: var(--color-error);
      border-color: var(--color-error);
    }
  }

  &__clear {
    padding: 0 6px;
    background: transparent;
    border: none;
    color: var(--color-text-tertiary);
    font-size: 10px;
    cursor: pointer;

    &:hover { color: var(--color-error); }
  }

  &__empty {
    text-align: center;
    padding: 16px;
    color: var(--color-text-disabled);
    font-size: 11px;
  }
}
</style>
