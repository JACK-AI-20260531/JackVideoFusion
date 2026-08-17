/**
 * 素材处理共享组合式函数
 * 职责:封装文件/目录选择(IPC dialog)、任务入队(useTaskStore)、进度跟踪
 * 所有 Tab 组件共用此 composable,避免重复代码
 */
import { ref, type Ref } from 'vue';
import { useTaskStore, type TaskItem } from '../../stores/task';
import { summarizeTaskOutput } from '../../utils/task-output-summary';
import { parseFfmpegProgress } from '../../utils/ffmpeg-progress';
import { shouldCopy } from '../../utils/clipboard';
import { joinLines } from '../../utils/join-lines';
import { resolveDirOf } from '../../utils/path-dir';
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

/**
 * 订阅主进程事件推送(返回退订函数)
 * @param channel 频道名
 * @param listener 监听器
 * @returns 退订函数
 */
export function apiOn(
  channel: string,
  listener: (...args: unknown[]) => void,
): () => void {
  return getApi().on(channel, listener);
}

// 文件筛选器格式(传给 Electron dialog)
interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * 从 IPC 返回数据中提取单个路径
 * @param data IPC 返回的路径数据
 * @returns 单个路径,不存在则返回 null
 */
function readPath(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return typeof data[0] === 'string' ? data[0] : null;
  }
  if (data && typeof data === 'object' && 'path' in data) {
    const path = (data as { path?: unknown }).path;
    return typeof path === 'string' ? path : null;
  }
  return null;
}

/**
 * 从 IPC 返回数据中提取多个路径
 * @param data IPC 返回的路径数据
 * @returns 路径数组,不存在则返回空数组
 */
function readPaths(data: unknown): string[] {
  if (Array.isArray(data)) {
    return data.filter((item): item is string => typeof item === 'string');
  }
  if (data && typeof data === 'object' && 'paths' in data) {
    const paths = (data as { paths?: unknown }).paths;
    return Array.isArray(paths)
      ? paths.filter((item): item is string => typeof item === 'string')
      : [];
  }
  const path = readPath(data);
  return path ? [path] : [];
}

/**
 * 生成唯一任务 ID(时间戳 + 随机数,无需额外依赖)
 * @returns 形如 "1a2b3c4d" 的唯一字符串
 */
export function generateTaskId(): string {
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
  showInFolder: (path: string) => Promise<void>;
  copyPath: (path: string) => Promise<void>;
  copyAllPaths: (paths: (string | undefined)[]) => Promise<void>;
  addDirToLibrary: (filePath: string) => Promise<{ ok: boolean; added: boolean; materialCount: number }>;
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
   * 记录文件选择失败信息
   * @param res IPC 响应
   * @param fallback 默认错误信息
   */
  function updatePickError(res: IpcResp<unknown>, fallback: string): void {
    if (!res.ok) {
      error.value = res.error ?? fallback;
    }
  }

  /**
   * 选择单个文件(调用 dialog:openFile IPC)
   * @param filters 文件扩展名筛选器
   * @returns 文件路径,取消则返回 null
   */
  async function pickFile(filters?: FileFilter[]): Promise<string | null> {
    error.value = null;
    const res = await getApi().invoke<{ filters?: FileFilter[] }, unknown>(
      'dialog:openFile',
      { filters },
    );
    updatePickError(res, '选择文件失败');
    return res.ok ? readPath(res.data) : null;
  }

  /**
   * 选择多个文件(调用 dialog:openFiles IPC)
   * @param filters 文件扩展名筛选器
   * @returns 文件路径数组,取消则返回空数组
   */
  async function pickFiles(filters?: FileFilter[]): Promise<string[]> {
    error.value = null;
    const res = await getApi().invoke<{ filters?: FileFilter[] }, unknown>(
      'dialog:openFiles',
      { filters },
    );
    updatePickError(res, '选择文件失败');
    return res.ok ? readPaths(res.data) : [];
  }

  /**
   * 选择目录(调用 dialog:openDirectory IPC)
   * @returns 目录路径,取消则返回 null
   */
  async function pickDirectory(): Promise<string | null> {
    error.value = null;
    const res = await getApi().invoke<unknown, unknown>('dialog:openDirectory', {});
    updatePickError(res, '选择目录失败');
    return res.ok ? readPath(res.data) : null;
  }

  /**
   * 在系统文件管理器中定位并选中文件
   * @param path 目标文件绝对路径
   */
  async function showInFolder(path: string): Promise<void> {
    if (!path) return;
    await getApi().invoke<{ path: string }, { shown: boolean }>('shell:showItemInFolder', {
      path,
    });
  }

  /**
   * 复制路径到剪贴板
   * @param path 待复制路径
   */
  async function copyPath(path: string): Promise<void> {
    await shouldCopy(path);
  }

  /**
   * 将多个路径一次性复制到剪贴板(按行分隔)
   * @param paths 路径数组
   */
  async function copyAllPaths(paths: (string | undefined)[]): Promise<void> {
    const text = joinLines(paths);
    if (text) {
      await shouldCopy(text);
    }
  }

  /**
   * 把产出文件所在目录注册进素材库并扫描(registerFolder 幂等,重复注册返回既有目录)
   * @param filePath 产出文件绝对路径
   * @returns 加入结果
   */
  async function addDirToLibrary(filePath: string): Promise<{ ok: boolean; added: boolean; materialCount: number }> {
    const dir = resolveDirOf(filePath);
    if (!dir) {
      return { ok: false, added: false, materialCount: 0 };
    }
    const folderRes = await getApi().invoke<{ path: string }, { id: string }>('material:addFolder', {
      path: dir,
    });
    if (!folderRes.ok || !folderRes.data?.id) {
      return { ok: false, added: false, materialCount: 0 };
    }
    const scanRes = await getApi().invoke<{ folderId: string }, unknown[]>('material:scanFolder', {
      folderId: folderRes.data.id,
    });
    return {
      ok: scanRes.ok,
      added: scanRes.ok,
      materialCount: Array.isArray(scanRes.data) ? scanRes.data.length : 0,
    };
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

    // 订阅任务进度推送(主进程通过 task:progress 频道推送)
    const unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
      const data = args[0] as { taskId: string; progress: number };
      if (data && data.taskId === taskId) {
        progress.value = data.progress;
        taskStore.updateTask(taskId, { status: 'running', progress: data.progress });
      }
    });

    // 订阅 ffmpeg 进度推送(素材分割等基于 ffmpeg 的长任务)
    const unsubscribeFfmpeg = getApi().on('ffmpeg:progress', (...args: unknown[]) => {
      const info = parseFfmpegProgress(args[0]);
      if (info && info.taskId === taskId) {
        progress.value = info.percent;
        taskStore.updateTask(taskId, { status: 'running', progress: info.percent });
      }
    });

    try {
      // 标记为执行中
      taskStore.updateTask(taskId, { status: 'running', startedAt: new Date().toISOString() });
      // 透传 taskId,便于主进程把 ffmpeg 进度关联到本任务
      const res = await getApi().invoke<Record<string, unknown>, T>(ipcChannel, {
        ...payload,
        taskId,
      });

      if (res.ok) {
        progress.value = 100;
        taskStore.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          output: summarizeTaskOutput(res.data),
          finishedAt: new Date().toISOString(),
        });
      } else {
        const msg = res.error ?? '未知错误';
        error.value = msg;
        taskStore.updateTask(taskId, {
          status: 'failed',
          error: msg,
          output: summarizeTaskOutput(undefined, msg),
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
        output: summarizeTaskOutput(undefined, msg),
        finishedAt: new Date().toISOString(),
      });
      return { ok: false, error: msg };
    } finally {
      running.value = false;
      unsubscribe();
      unsubscribeFfmpeg();
    }
  }

  return { running, progress, error, pickFile, pickFiles, pickDirectory, showInFolder, copyPath, copyAllPaths, addDirToLibrary, runTask };
}
