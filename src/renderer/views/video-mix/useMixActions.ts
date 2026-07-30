/**
 * 视频混剪共享组合式函数
 * 职责:封装混剪任务执行、进度订阅、暂停/取消控制
 * 两个 Tab(RandomMixTab / AudioMatchTab)共用此 composable
 *
 * 关键差异(与 useMaterialActions 的对比):
 *  - 不通过 taskStore 维护任务(主进程 taskQueue 已持久化)
 *  - 直接订阅 'task:progress' 频道接收主进程推送
 *  - pause/cancel 通过独立 IPC 通道(video-mix:pause / video-mix:cancel)调用
 */
import { ref, type Ref } from 'vue';
import type {
  ResolutionPreset,
  WatermarkConfig,
  SubtitleStyleConfig,
  TaskStatus,
} from '@shared/types';

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

// 文件筛选器格式(传给 Electron dialog)
interface FileFilter {
  name: string;
  extensions: string[];
}

// 当前任务的最小结构(订阅 task:progress 推送)
interface TaskProgress {
  taskId: string;
  status: TaskStatus;
  progress: number;
  output?: string;
  error?: string;
}

/**
 * 混剪模式
 * 与主进程 src/main/services/video-mix/types.ts 保持一致
 */
export type MixMode = 'random' | 'audio-match';

/**
 * 混剪参数(渲染层版本)
 * 与主进程 MixParams 结构保持一致,字段类型对齐
 */
export interface MixParams {
  mode: MixMode;
  folderIds: string[];
  perFolderCount?: number;
  targetDurationSec?: number;
  uniqueReuse?: boolean;
  segmentSec?: number;
  resolution: ResolutionPreset;
  keepOriginalQuality: boolean;
  watermark?: WatermarkConfig | null;
  subtitle?: { srtPath: string; style?: SubtitleStyleConfig } | null;
  stripOriginalAudio?: boolean;
  audioFadeSec?: number;
  audioLoop?: boolean;
  transitionSec?: number;
  outputDir?: string;
  outputName?: string;
}

/**
 * 混剪结果
 */
export interface MixResult {
  outputPath: string;
  durationSec: number;
  segmentCount: number;
}

// video-mix:start IPC 返回结构
interface StartResp {
  taskId: string;
  result: MixResult;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 视频混剪共享动作 composable
 * 提供:文件/目录选择、混剪任务启动、进度跟踪、暂停/取消
 * 每个 Tab 调用一次,获得独立的 running/progress/error/currentTaskId 状态
 */
export function useMixActions(): {
  running: Ref<boolean>;
  progress: Ref<number>;
  error: Ref<string | null>;
  currentTaskId: Ref<string | null>;
  start: (params: MixParams) => Promise<IpcResp<StartResp>>;
  pause: () => Promise<void>;
  cancel: () => Promise<void>;
  pickFile: (filters?: FileFilter[]) => Promise<string | null>;
  pickDirectory: () => Promise<string | null>;
} {
  // 是否执行中
  const running = ref(false);
  // 进度 0-100
  const progress = ref(0);
  // 错误信息
  const error = ref<string | null>(null);
  // 当前任务 ID(用于 pause/cancel)
  const currentTaskId = ref<string | null>(null);
  // 进度订阅取消函数
  let unsubscribe: (() => void) | null = null;

  /**
   * 选择单个文件(调用 dialog:openFile IPC)
   * 注意:dialog IPC 返回 string[] | null,本函数提取第一个元素
   * @param filters 文件扩展名筛选器
   * @returns 文件路径,取消则返回 null
   */
  async function pickFile(filters?: FileFilter[]): Promise<string | null> {
    const res = await getApi().invoke<{ filters?: FileFilter[] }, string[] | null>(
      'dialog:openFile',
      { filters },
    );
    if (res.ok && res.data && res.data.length > 0) {
      return res.data[0];
    }
    return null;
  }

  /**
   * 选择目录(调用 dialog:openDirectory IPC)
   * @returns 目录路径,取消则返回 null
   */
  async function pickDirectory(): Promise<string | null> {
    const res = await getApi().invoke<unknown, string | null>('dialog:openDirectory', {});
    return res.ok && res.data ? res.data : null;
  }

  /**
   * 启动混剪任务
   * @param params 混剪参数
   * @returns IPC 响应(含 taskId 与 result)
   */
  async function start(params: MixParams): Promise<IpcResp<StartResp>> {
    running.value = true;
    progress.value = 0;
    error.value = null;
    currentTaskId.value = null;

    // 订阅进度推送(主进程通过 task:progress 频道推送)
    unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
      const data = args[0] as TaskProgress;
      if (data && currentTaskId.value && data.taskId === currentTaskId.value) {
        progress.value = data.progress;
        // 终态时自动停止 running
        if (
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled'
        ) {
          running.value = false;
          if (data.status === 'failed' && data.error) {
            error.value = data.error;
          }
        }
      }
    });

    try {
      const res = await getApi().invoke<MixParams, StartResp>('video-mix:start', params);
      if (res.ok && res.data) {
        currentTaskId.value = res.data.taskId;
        // 主进程在 runMix 返回前已完成,start IPC 返回即任务完成
        progress.value = 100;
        running.value = false;
      } else {
        error.value = res.error ?? '未知错误';
        running.value = false;
      }
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      running.value = false;
      return { ok: false, error: msg };
    } finally {
      // 取消订阅(任务结束后不再需要监听)
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    }
  }

  /**
   * 暂停当前混剪任务
   */
  async function pause(): Promise<void> {
    if (!currentTaskId.value) return;
    await getApi().invoke<{ taskId: string }, { paused: string }>(
      'video-mix:pause',
      { taskId: currentTaskId.value },
    );
    running.value = false;
  }

  /**
   * 取消当前混剪任务
   */
  async function cancel(): Promise<void> {
    if (!currentTaskId.value) return;
    await getApi().invoke<{ taskId: string }, { cancelled: string }>(
      'video-mix:cancel',
      { taskId: currentTaskId.value },
    );
    running.value = false;
    currentTaskId.value = null;
  }

  return {
    running,
    progress,
    error,
    currentTaskId,
    start,
    pause,
    cancel,
    pickFile,
    pickDirectory,
  };
}
