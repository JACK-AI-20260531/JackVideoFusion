/**
 * 素材处理共享组合式函数
 * 职责:封装文件/目录选择(IPC dialog)、任务入队(useTaskStore)、进度跟踪
 * 所有 Tab 组件共用此 composable,避免重复代码
 */
import { ref, type Ref } from 'vue';
import { useTaskStore, type TaskItem } from '../../stores/task';
import type { TaskType } from '@shared/types';

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
}

// 从 window 安全获取 api(避免全局类型声明冲突)
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 类型安全的 IPC invoke 快捷方法(供不便使用 composable 的场景直接调用)
 * @param channel IPC 通道名
 * @param payload IPC 载荷
 * @returns IPC 响应
 */
export function apiInvoke<TReq, TResp>(
  channel: string,
  payload?: TReq,
): Promise<IpcResp<TResp>> {
  return getApi().invoke<TReq, TResp>(channel, payload);
}

// 文件筛选器格式(传给 Electron dialog)
interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * 生成唯一任务 ID(时间戳 + 随机数,无需额外依赖)
 * @returns 形如 "1a2b3c4d" 的唯一字符串
 */
function generateTaskId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 素材处理共享动作 composable
 * 提供:文件选择、目录选择、任务执行(入队 + 进度跟踪 + 结果返回)
 * 每个 Tab 调用一次,获得独立的 running/progress/error 响应式状态
 */
export function useMaterialActions(): {
  running: Ref<boolean>;
  progress: Ref<number>;
  error: Ref<string | null>;
  pickFile: (filters?: FileFilter[]) => Promise<string | null>;
  pickFiles: (filters?: FileFilter[]) => Promise<string[]>;
  pickDirectory: () => Promise<string | null>;
  runTask: <T>(
    type: TaskType,
    title: string,
    ipcChannel: string,
    payload: Record<string, unknown>,
  ) => Promise<IpcResp<T>>;
} {
  const taskStore = useTaskStore();
  // 是否执行中
  const running = ref(false);
  // 进度 0-100
  const progress = ref(0);
  // 错误信息
  const error = ref<string | null>(null);

  /**
   * 选择单个文件(调用 dialog:openFile IPC)
   * @param filters 文件扩展名筛选器
   * @returns 文件路径,取消则返回 null
   */
  async function pickFile(filters?: FileFilter[]): Promise<string | null> {
    const res = await getApi().invoke<{ filters?: FileFilter[] }, { path: string }>(
      'dialog:openFile',
      { filters },
    );
    return res.ok && res.data ? res.data.path : null;
  }

  /**
   * 选择多个文件(调用 dialog:openFiles IPC)
   * @param filters 文件扩展名筛选器
   * @returns 文件路径数组,取消则返回空数组
   */
  async function pickFiles(filters?: FileFilter[]): Promise<string[]> {
    const res = await getApi().invoke<{ filters?: FileFilter[] }, { paths: string[] }>(
      'dialog:openFiles',
      { filters },
    );
    return res.ok && res.data ? res.data.paths : [];
  }

  /**
   * 选择目录(调用 dialog:openDirectory IPC)
   * @returns 目录路径,取消则返回 null
   */
  async function pickDirectory(): Promise<string | null> {
    const res = await getApi().invoke<unknown, { path: string }>('dialog:openDirectory', {});
    return res.ok && res.data ? res.data.path : null;
  }

  /**
   * 执行任务:入队 → 订阅进度 → 调用 IPC → 更新状态
   * @param type 任务类型(对应 TaskType)
   * @param title 任务标题(显示在任务队列)
   * @param ipcChannel IPC 通道名
   * @param payload IPC 载荷
   * @returns IPC 响应
   */
  async function runTask<T>(
    type: TaskType,
    title: string,
    ipcChannel: string,
    payload: Record<string, unknown>,
  ): Promise<IpcResp<T>> {
    running.value = true;
    progress.value = 0;
    error.value = null;

    // 生成任务 ID 并入队
    const taskId = generateTaskId();
    const task: TaskItem = {
      id: taskId,
      type,
      title,
      status: 'pending',
      progress: 0,
      params: payload,
      createdAt: new Date().toISOString(),
    };
    taskStore.enqueue(task);

    // 订阅进度推送(主进程通过 task:progress 频道推送)
    const unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
      const data = args[0] as { taskId: string; progress: number };
      if (data && data.taskId === taskId) {
        progress.value = data.progress;
        taskStore.updateTask(taskId, { status: 'running', progress: data.progress });
      }
    });

    try {
      // 标记为执行中
      taskStore.updateTask(taskId, { status: 'running', startedAt: new Date().toISOString() });
      const res = await getApi().invoke<Record<string, unknown>, T>(ipcChannel, payload);

      if (res.ok) {
        progress.value = 100;
        taskStore.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          output: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
          finishedAt: new Date().toISOString(),
        });
      } else {
        error.value = res.error ?? '未知错误';
        taskStore.updateTask(taskId, {
          status: 'failed',
          error: res.error,
          finishedAt: new Date().toISOString(),
        });
      }
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      taskStore.updateTask(taskId, {
        status: 'failed',
        error: msg,
        finishedAt: new Date().toISOString(),
      });
      return { ok: false, error: msg };
    } finally {
      running.value = false;
      unsubscribe();
    }
  }

  return { running, progress, error, pickFile, pickFiles, pickDirectory, runTask };
}
