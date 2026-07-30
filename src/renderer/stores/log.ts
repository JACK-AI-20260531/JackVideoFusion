/**
 * 日志状态仓库
 * 职责:接收主进程广播的日志、按模块过滤、最大条数限制
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LogEntry } from '@shared/types';

// 单仓库最大日志条数,超出后滚动丢弃
const MAX_LOG_ENTRIES = 2000;

export const useLogStore = defineStore('log', () => {
  // 日志条目列表(最新追加在末尾)
  const entries = ref<LogEntry[]>([]);
  // 当前过滤的模块名(null 表示全部)
  const filterModule = ref<string | null>(null);

  // 追加一条日志
  function append(entry: LogEntry): void {
    entries.value.push(entry);
    if (entries.value.length > MAX_LOG_ENTRIES) {
      entries.value.splice(0, entries.value.length - MAX_LOG_ENTRIES);
    }
  }
  // 批量追加(用于初始化时回填历史日志)
  function appendBatch(items: LogEntry[]): void {
    entries.value.push(...items);
    if (entries.value.length > MAX_LOG_ENTRIES) {
      entries.value.splice(0, entries.value.length - MAX_LOG_ENTRIES);
    }
  }
  // 清空日志
  function clear(): void {
    entries.value = [];
  }
  // 设置模块过滤
  function setFilter(name: string | null): void {
    filterModule.value = name;
  }

  return { entries, filterModule, append, appendBatch, clear, setFilter };
});
