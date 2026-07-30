<script setup lang="ts">
/**
 * 底部日志面板
 * 职责:订阅主进程日志广播,实时显示,支持按级别过滤与清空
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useLogStore } from '../../stores/log';
import type { LogEntry } from '@shared/types';

// 日志仓库
const logStore = useLogStore();

// 当前级别过滤
const levelFilter = ref<LogEntry['level'] | 'all'>('all');
// 自动滚动到底部
const autoScroll = ref(true);

// 过滤后的日志条目
const filteredEntries = computed(() => {
  if (levelFilter.value === 'all') return logStore.entries;
  return logStore.entries.filter((e) => e.level === levelFilter.value);
});

// 级别对应的颜色
function levelColor(level: LogEntry['level']): string {
  const map: Record<LogEntry['level'], string> = {
    info: 'var(--color-info)',
    warn: 'var(--color-warning)',
    error: 'var(--color-error)',
    debug: 'var(--color-text-tertiary)',
  };
  return map[level] ?? 'var(--color-text-secondary)';
}

// 清空日志
function handleClear(): void {
  logStore.clear();
}

// TODO: 在 002/009 任务完成时,通过 window.api.on('log:append', ...) 订阅主进程日志
onMounted(() => {
  // 占位:订阅 IPC 日志事件
});
onUnmounted(() => {
  // 占位:取消订阅
});
</script>

<template>
  <div class="log-panel">
    <!-- 工具栏 -->
    <div class="log-panel__toolbar">
      <div class="log-panel__filters">
        <button
          v-for="lvl in ['all', 'info', 'warn', 'error', 'debug'] as const"
          :key="lvl"
          class="log-panel__filter"
          :class="{ 'log-panel__filter--active': levelFilter === lvl }"
          @click="levelFilter = lvl"
        >
          {{ lvl === 'all' ? '全部' : lvl }}
        </button>
      </div>
      <div class="log-panel__actions">
        <label class="log-panel__autoscroll">
          <input v-model="autoScroll" type="checkbox" /> 自动滚动
        </label>
        <button class="log-panel__clear" @click="handleClear">清空</button>
      </div>
    </div>

    <!-- 日志列表 -->
    <div class="log-panel__list">
      <div
        v-for="(entry, idx) in filteredEntries"
        :key="idx"
        class="log-panel__entry"
      >
        <span class="log-panel__time">{{ entry.timestamp }}</span>
        <span class="log-panel__level" :style="{ color: levelColor(entry.level) }">
          [{{ entry.level.toUpperCase() }}]
        </span>
        <span class="log-panel__message">{{ entry.message }}</span>
      </div>
      <div v-if="filteredEntries.length === 0" class="log-panel__empty">
        暂无日志
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

  &__actions {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--color-text-tertiary);
  }

  &__autoscroll {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  &__clear {
    background: transparent;
    border: none;
    color: var(--color-text-tertiary);
    font-size: 11px;
    cursor: pointer;
    &:hover { color: var(--color-error); }
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
}
</style>
