<script setup lang="ts">
/**
 * 底部日志面板
 * 职责:订阅主进程日志广播,实时显示,支持按级别/模块/任务过滤、清空与导出
 * 性能:computed 缓存过滤结果,限制最多渲染 500 条避免卡顿
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useLogStore } from '../../stores/log';
import type { LogEntry } from '@shared/types';

// 日志仓库
const logStore = useLogStore();

// 当前级别过滤
const levelFilter = ref<LogEntry['level'] | 'all'>('all');
// 当前模块过滤
const moduleFilter = ref<string>('all');
// 当前任务过滤
const taskFilter = ref<string>('all');
// 自动滚动到底部
const autoScroll = ref(true);

// 模块过滤选项(与后端服务模块一一对应)
const MODULE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: '全部模块' },
  { value: 'common', label: '通用/IPC' },
  { value: 'ffmpeg', label: 'FFmpeg' },
  { value: 'tts', label: 'TTS' },
  { value: 'material', label: '素材仓库' },
  { value: 'video-mix', label: '视频混剪' },
  { value: 'llm', label: 'LLM大模型' },
  { value: 'clip', label: 'CLIP视觉模型' },
  { value: 'shot-detect', label: '镜头检测' },
  { value: 'ai-edit', label: 'AI剪辑' },
  { value: 'ai-slice', label: 'AI切片' },
  { value: 'film-dub-clone', label: '影视解说克隆' },
  { value: 'voice-clone', label: '语音克隆' },
  { value: 'auto-publish', label: '自动发布' },
  { value: 'task-queue', label: '任务队列' },
  { value: 'config', label: '配置' },
  { value: 'storage', label: '存储' },
];

// 最大渲染条数(性能保护)
const MAX_RENDER_ENTRIES = 500;

// 日志列表 DOM 引用(用于自动滚动)
const listRef = ref<HTMLElement | null>(null);

/**
 * 过滤后的日志条目(按级别、模块、任务三维过滤)
 * 使用 computed 缓存,避免每次渲染重复计算
 */
const filteredEntries = computed<LogEntry[]>(() => {
  let result = logStore.entries;
  if (levelFilter.value !== 'all') {
    result = result.filter((e) => e.level === levelFilter.value);
  }
  if (moduleFilter.value !== 'all') {
    result = result.filter((e) => e.module === moduleFilter.value);
  }
  if (taskFilter.value !== 'all') {
    result = result.filter((e) => e.taskId === taskFilter.value);
  }
  return result;
});

/**
 * 实际渲染的日志条目(限制最多 500 条,取最新的)
 */
const renderEntries = computed<LogEntry[]>(() => {
  const all = filteredEntries.value;
  if (all.length <= MAX_RENDER_ENTRIES) return all;
  return all.slice(all.length - MAX_RENDER_ENTRIES);
});

/**
 * 从日志条目中提取最近的任务 ID 列表(去重,取最近 20 个)
 */
const recentTaskIds = computed<string[]>(() => {
  const ids: string[] = [];
  const seen = new Set<string>();
  // 从最新到最旧遍历,收集去重后的 taskId
  for (let i = logStore.entries.length - 1; i >= 0 && ids.length < 20; i--) {
    const tid = logStore.entries[i].taskId;
    if (tid && !seen.has(tid)) {
      seen.add(tid);
      ids.push(tid);
    }
  }
  return ids;
});

/**
 * 级别对应的颜色
 * @param level 日志级别
 * @returns CSS 颜色变量
 */
function levelColor(level: LogEntry['level']): string {
  const map: Record<LogEntry['level'], string> = {
    info: 'var(--color-info)',
    warn: 'var(--color-warning)',
    error: 'var(--color-error)',
    debug: 'var(--color-text-tertiary)',
  };
  return map[level] ?? 'var(--color-text-secondary)';
}

/**
 * 清空日志
 */
function handleClear(): void {
  logStore.clear();
}

/**
 * 导出当前过滤后的日志为 TXT 文件(使用 Blob 下载)
 */
function handleExport(): void {
  const entries = filteredEntries.value;
  if (entries.length === 0) return;
  // 拼接日志文本
  const lines = entries.map((e) => {
    const moduleTag = e.module ? ` [${e.module}]` : '';
    const taskTag = e.taskId ? ` [task:${e.taskId}]` : '';
    return `[${e.timestamp}] [${e.level.toUpperCase()}]${moduleTag}${taskTag} ${e.message}`;
  });
  const text = lines.join('\n');
  // 创建 Blob 并触发下载
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jvf-log-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 自动滚动到底部
 */
function scrollToBottom(): void {
  if (autoScroll.value && listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight;
  }
}

// 监听渲染列表变化,自动滚动
watch(
  () => renderEntries.value.length,
  () => {
    nextTick(scrollToBottom);
  },
);

// 挂载时订阅日志
onMounted(() => {
  // IPC 订阅兜底:主进程未就绪时不抛未处理 rejection
  logStore.subscribe().catch(() => {});
});

// 卸载时取消订阅
onUnmounted(() => {
  logStore.unsubscribe();
});
</script>

<template>
  <div class="log-panel">
    <!-- 工具栏 -->
    <div class="log-panel__toolbar">
      <div class="log-panel__filters">
        <!-- 级别过滤 -->
        <button
          v-for="lvl in ['all', 'info', 'warn', 'error', 'debug'] as const"
          :key="lvl"
          class="log-panel__filter"
          :class="{ 'log-panel__filter--active': levelFilter === lvl }"
          @click="levelFilter = lvl"
        >
          {{ lvl === 'all' ? '全部' : lvl }}
        </button>
        <!-- 模块过滤 -->
        <select v-model="moduleFilter" class="log-panel__select" title="按模块过滤">
          <option v-for="opt in MODULE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <!-- 任务过滤 -->
        <select v-model="taskFilter" class="log-panel__select" title="按任务过滤">
          <option value="all">全部任务</option>
          <option v-for="tid in recentTaskIds" :key="tid" :value="tid">{{ tid.slice(0, 12) }}</option>
        </select>
      </div>
      <div class="log-panel__actions">
        <span class="log-panel__count">{{ filteredEntries.length }} 条</span>
        <label class="log-panel__autoscroll">
          <input v-model="autoScroll" type="checkbox" /> 自动滚动
        </label>
        <button class="log-panel__btn" @click="handleExport">导出</button>
        <button class="log-panel__btn log-panel__btn--danger" @click="handleClear">清空</button>
      </div>
    </div>

    <!-- 日志列表 -->
    <div ref="listRef" class="log-panel__list">
      <div
        v-for="(entry, idx) in renderEntries"
        :key="idx"
        class="log-panel__entry"
        v-memo="[entry.timestamp, entry.message, entry.level]"
      >
        <span class="log-panel__time">{{ entry.timestamp }}</span>
        <span class="log-panel__level" :style="{ color: levelColor(entry.level) }">
          [{{ entry.level.toUpperCase() }}]
        </span>
        <span v-if="entry.module" class="log-panel__module">[{{ entry.module }}]</span>
        <span class="log-panel__message">{{ entry.message }}</span>
      </div>
      <div v-if="filteredEntries.length === 0" class="log-panel__empty">
        暂无日志
      </div>
      <div v-else-if="filteredEntries.length > MAX_RENDER_ENTRIES" class="log-panel__truncated">
        (仅显示最近 {{ MAX_RENDER_ENTRIES }} 条,共 {{ filteredEntries.length }} 条)
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.log-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-mono, monospace);

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &__filters {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  &__filter {
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    border-radius: 3px;
    color: var(--color-text-tertiary);
    font-size: 11px;
    cursor: pointer;

    &:hover { color: var(--color-text-secondary); }
    &--active {
      background: var(--color-accent-soft);
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
  }

  &__select {
    height: 22px;
    padding: 0 6px;
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    border-radius: 3px;
    color: var(--color-text-tertiary);
    font-size: 11px;
    outline: none;
    cursor: pointer;

    &:hover { color: var(--color-text-secondary); }
    option { background: var(--color-bg-elevated); color: var(--color-text-primary); }
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--color-text-tertiary);
  }

  &__count {
    color: var(--color-text-tertiary);
  }

  &__autoscroll {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  &__btn {
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--color-border-subtle);
    border-radius: 3px;
    color: var(--color-text-tertiary);
    font-size: 11px;
    cursor: pointer;

    &:hover { color: var(--color-text-secondary); border-color: var(--color-border-strong); }

    &--danger:hover { color: var(--color-error); }
  }

  &__list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 12px;
  }

  &__entry {
    display: flex;
    gap: 8px;
    padding: 1px 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--color-text-secondary);
  }

  &__time {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  &__level {
    flex-shrink: 0;
    min-width: 56px;
  }

  &__module {
    flex-shrink: 0;
    color: var(--color-text-tertiary);
  }

  &__message {
    flex: 1;
    word-break: break-all;
  }

  &__empty {
    text-align: center;
    color: var(--color-text-disabled);
    font-size: 11px;
    padding: 20px;
  }

  &__truncated {
    text-align: center;
    color: var(--color-text-disabled);
    font-size: 10px;
    padding: 4px;
    border-top: 1px solid var(--color-border-subtle);
  }
}
</style>
