/**
 * 日志状态仓库
 * 职责:接收主进程广播的日志、按模块/任务过滤、最大条数限制
 *       通过 window.api.on('log:append', ...) 订阅主进程日志广播
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LogEntry } from '@shared/types';

// 单仓库最大日志条数,超出后滚动丢弃头部
const MAX_LOG_ENTRIES = 2000;

// IPC 响应结构(与 preload.ts / shared/types.ts IpcResponse 一致)
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明(与 preload.ts ExposedApi 保持一致)
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * 从 window 安全获取 api(避免全局类型声明冲突)
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

export const useLogStore = defineStore('log', () => {
  // 日志条目列表(最新追加在末尾)
  const entries = ref<LogEntry[]>([]);
  // 当前过滤的模块名(null 表示全部)
  const filterModule = ref<string | null>(null);
  // 当前过滤的任务 ID(null 表示全部)
  const filterTaskId = ref<string | null>(null);

  // 日志事件处理器引用(用于取消订阅)
  let logHandler: ((...args: unknown[]) => void) | null = null;

  /**
   * 追加一条日志,超出上限时丢弃头部
   * @param entry 日志条目
   */
  function append(entry: LogEntry): void {
    entries.value.push(entry);
    if (entries.value.length > MAX_LOG_ENTRIES) {
      entries.value.splice(0, entries.value.length - MAX_LOG_ENTRIES);
    }
  }

  /**
   * 批量追加日志(用于初始化时回填历史日志)
   * @param items 日志条目数组
   */
  function appendBatch(items: LogEntry[]): void {
    entries.value.push(...items);
    if (entries.value.length > MAX_LOG_ENTRIES) {
      entries.value.splice(0, entries.value.length - MAX_LOG_ENTRIES);
    }
  }

  /**
   * 订阅主进程日志广播
   * 调用 log:subscribe IPC 声明订阅,并注册 'log:append' 事件监听器
   */
  async function subscribe(): Promise<void> {
    if (logHandler) return;
    await getApi().invoke('log:subscribe');
    logHandler = (...args: unknown[]): void => {
      const entry = args[0] as LogEntry;
      if (entry && typeof entry === 'object' && 'message' in entry) {
        append(entry);
      }
    };
    getApi().on('log:append', logHandler);
  }

  /**
   * 取消订阅主进程日志广播
   * 通过 off 移除监听器
   */
  function unsubscribe(): void {
    if (logHandler) {
      getApi().off('log:append', logHandler);
      logHandler = null;
    }
  }

  /**
   * 清空日志
   */
  function clear(): void {
    entries.value = [];
  }

  /**
   * 设置模块过滤
   * @param name 模块名,null 表示全部
   */
  function filterByModule(name: string | null): void {
    filterModule.value = name;
  }

  /**
   * 设置任务过滤
   * @param taskId 任务 ID,null 表示全部
   */
  function filterByTask(taskId: string | null): void {
    filterTaskId.value = taskId;
  }

  /**
   * 设置模块过滤(兼容旧接口 setFilter)
   * @param name 模块名,null 表示全部
   */
  function setFilter(name: string | null): void {
    filterModule.value = name;
  }

  return {
    entries,
    filterModule,
    filterTaskId,
    append,
    appendBatch,
    clear,
    subscribe,
    unsubscribe,
    filterByModule,
    filterByTask,
    setFilter,
  };
});
