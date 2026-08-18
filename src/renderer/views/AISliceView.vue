<script setup lang="ts">
/**
 * AI 切片剪辑视图
 *
 * 职责:长视频 → 镜头检测 → AI 精彩度评估 → 自动切片拆分为多条独立短视频
 *
 * 调用 IPC:
 *   ai-slice:start        - 启动 AI 切片任务
 *   ai-slice:cancel       - 取消任务
 *   dialog:openFile       - 选择视频文件
 *   dialog:openDirectory  - 选择输出目录
 *   common:listResolutions - 加载分辨率列表
 *   task:progress         - 订阅任务进度推送
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useConfigStore } from '../stores/config';
import ProgressBar from './material-process/ProgressBar.vue';
import WatermarkEditor from '../components/WatermarkEditor.vue';
import type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  WatermarkPosition,
  TaskStatus,
} from '@shared/types';

// 配置仓库(用于加载默认值)
const configStore = useConfigStore();

// ===== 表单参数 =====
// 输入长视频路径
const videoPath = ref('');
// 最小片段时长(秒)
const minClipDuration = ref(8);
// 最大片段时长(秒)
const maxClipDuration = ref(30);
// 精彩度阈值(0-1)
const excitementThreshold = ref(0.5);
// 输出片段数量(0=不限)
const maxClipCount = ref(0);
// 分辨率预设
const resolution = ref<ResolutionPreset>('1080p');
// 是否保留原画质
const keepOriginalQuality = ref(true);
// 输出目录
const outputDir = ref('');
// 输出文件名前缀
const outputPrefix = ref('clip');

// 水印配置
const watermarkConfig = ref<WatermarkConfig>({
  enabled: false,
  type: 'text',
  content: '',
  position: 'bottom-right' as WatermarkPosition,
  opacity: 80,
  marginX: 20,
  marginY: 20,
  fontSize: 24,
  fontColor: 'white',
});

// 分辨率列表(从主进程获取)
const resolutions = ref<ResolutionInfo[]>([]);

// ===== 任务执行状态 =====
// 切片结果列表
const clips = ref<SliceClip[]>([]);
// 是否运行中
const running = ref(false);
// 进度百分比
const progress = ref(0);
// 错误信息
const error = ref<string | null>(null);
// 当前任务 ID
const currentTaskId = ref<string | null>(null);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(视频路径非空 + 未运行)
const canStart = computed(
  () => videoPath.value.trim().length > 0 && !running.value,
);

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

// 任务进度推送载荷
interface TaskProgress {
  taskId: string;
  status: TaskStatus;
  progress: number;
  output?: string;
  error?: string;
}

// 单个切片结果(与主进程 SliceClip 结构一致)
interface SliceClip {
  index: number;
  outputPath: string;
  startTime: number;
  endTime: number;
  duration: number;
  excitementScore: number;
}

// ai-slice:start IPC 返回结构
interface AiSliceStartResp {
  taskId: string;
  result: {
    clips: SliceClip[];
    totalClips: number;
  };
}

// 进度订阅取消函数
let unsubscribe: (() => void) | null = null;

/**
 * 组件挂载时加载分辨率列表与配置默认值
 */
onMounted(async () => {
  // IPC 调用做错误兜底:主进程未就绪或调用失败时静默降级
  try {
    await configStore.load();
    const res = await getApi().invoke<unknown, ResolutionInfo[]>('common:listResolutions');
    if (res.ok && res.data) {
      resolutions.value = res.data;
    }
    // 用配置中的默认值初始化表单
    if (configStore.config.defaultExportDir) {
      outputDir.value = configStore.config.defaultExportDir;
    }
    resolution.value = configStore.config.defaultResolution;
    keepOriginalQuality.value = configStore.config.keepOriginalQuality;
  } catch {
    // 降级:保持默认值,不阻断渲染
  }
});

/**
 * 组件卸载时取消进度订阅
 */
onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

/**
 * 选择输入视频文件
 */
async function handlePickVideo(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFile', {
    title: '选择视频文件',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.ok && res.data && res.data.length > 0) {
    videoPath.value = res.data[0];
  }
}

/**
 * 选择输出目录
 */
async function handlePickOutputDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择输出目录',
  });
  if (res.ok && res.data) {
    outputDir.value = res.data;
  }
}

/**
 * 格式化时间为 mm:ss.s
 * @param sec 秒数
 * @returns 格式化后的时间字符串
 */
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
}

/**
 * 开始 AI 切片
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  clips.value = [];
  error.value = null;
  running.value = true;
  progress.value = 0;
  currentTaskId.value = null;

  // 订阅进度推送
  unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
    const data = args[0] as TaskProgress;
    if (data && currentTaskId.value && data.taskId === currentTaskId.value) {
      progress.value = data.progress;
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
    // 构造 AI 切片参数
    const params = {
      videoPath: videoPath.value,
      resolution: resolution.value,
      keepOriginalQuality: keepOriginalQuality.value,
      minClipDuration: minClipDuration.value,
      maxClipDuration: maxClipDuration.value,
      excitementThreshold: excitementThreshold.value,
      maxClipCount: maxClipCount.value,
      watermark: watermarkConfig.value.enabled ? watermarkConfig.value : null,
      outputDir: outputDir.value,
      outputPrefix: outputPrefix.value,
    };

    const res = await getApi().invoke<typeof params, AiSliceStartResp>('ai-slice:start', params);
    if (res.ok && res.data) {
      currentTaskId.value = res.data.taskId;
      clips.value = res.data.result.clips;
      progress.value = 100;
      running.value = false;
    } else {
      error.value = res.error ?? 'AI 切片失败';
      running.value = false;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    running.value = false;
  } finally {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }
}

/**
 * 取消当前 AI 切片任务
 */
async function handleCancel(): Promise<void> {
  if (!currentTaskId.value) return;
  await getApi().invoke<{ taskId: string }, { cancelled: string }>('ai-slice:cancel', {
    taskId: currentTaskId.value,
  });
  running.value = false;
  currentTaskId.value = null;
}
</script>

<template>
  <div class="ai-slice-view">
    <!-- 页面标题 -->
    <div class="ai-slice-view__header">
      <h2 class="ai-slice-view__title">AI 切片剪辑</h2>
      <p class="ai-slice-view__desc">批量导入长视频,AI 自动识别精彩片段、镜头卡点,自动切片拆分多条独立短视频</p>
    </div>

    <!-- 视频文件选择 -->
    <section class="form-section">
      <h3 class="section-title">输入视频</h3>
      <div class="form-row">
        <label class="form-label">视频文件</label>
        <div class="form-input-group">
          <input v-model="videoPath" class="form-input" placeholder="请选择长视频文件" readonly />
          <button class="btn btn--small" @click="handlePickVideo">选择</button>
        </div>
      </div>
    </section>

    <!-- 切片参数 -->
    <section class="form-section">
      <h3 class="section-title">切片参数</h3>
      <div class="form-row">
        <label class="form-label">最小片段时长(秒)</label>
        <input
          v-model.number="minClipDuration"
          type="number"
          min="1"
          step="1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">最大片段时长(秒)</label>
        <input
          v-model.number="maxClipDuration"
          type="number"
          min="1"
          step="1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">精彩度阈值(0-1)</label>
        <input
          v-model.number="excitementThreshold"
          type="number"
          min="0"
          max="1"
          step="0.1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">输出片段数量</label>
        <input
          v-model.number="maxClipCount"
          type="number"
          min="0"
          step="1"
          class="form-input form-input--narrow"
        />
        <span class="form-hint">0 = 不限,输出所有达标片段</span>
      </div>
    </section>

    <!-- 输出设置 -->
    <section class="form-section">
      <h3 class="section-title">输出设置</h3>
      <div class="form-row">
        <label class="form-label">分辨率</label>
        <select v-model="resolution" class="form-select">
          <option v-for="r in resolutions" :key="r.preset" :value="r.preset">{{ r.label }}</option>
        </select>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="keepOriginalQuality" type="checkbox" /> 保留原画质(不做缩放)
        </label>
      </div>
      <div class="form-row">
        <label class="form-label">输出目录</label>
        <div class="form-input-group">
          <input v-model="outputDir" class="form-input" placeholder="请选择输出目录" readonly />
          <button class="btn btn--small" @click="handlePickOutputDir">选择</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">文件名前缀</label>
        <input v-model="outputPrefix" class="form-input form-input--narrow" placeholder="clip" />
      </div>
    </section>

    <!-- 水印 -->
    <section class="form-section">
      <h3 class="section-title">水印</h3>
      <WatermarkEditor v-model="watermarkConfig" />
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '切片中...' : '开始 AI 切片' }}
      </button>
      <button class="btn" :disabled="!running" @click="handleCancel">取消</button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="clips.length > 0" class="result-section">
      <h3 class="section-title">切片完成({{ clips.length }} 个)</h3>
      <div class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th class="result-table__th">#</th>
              <th class="result-table__th">起始</th>
              <th class="result-table__th">结束</th>
              <th class="result-table__th">时长</th>
              <th class="result-table__th">精彩度</th>
              <th class="result-table__th">文件路径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="clip in clips" :key="clip.index">
              <td class="result-table__td">{{ clip.index }}</td>
              <td class="result-table__td">{{ formatTime(clip.startTime) }}</td>
              <td class="result-table__td">{{ formatTime(clip.endTime) }}</td>
              <td class="result-table__td">{{ clip.duration.toFixed(1) }}s</td>
              <td class="result-table__td result-table__td--score">
                {{ (clip.excitementScore * 100).toFixed(0) }}%
              </td>
              <td class="result-table__td result-table__td--path" :title="clip.outputPath">
                {{ clip.outputPath }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无切片结果,请先选择视频并点击「开始 AI 切片」</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.ai-slice-view {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__header {
    margin-bottom: 4px;
  }

  &__title {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 4px;
  }

  &__desc {
    font-size: 12px;
    color: var(--color-text-tertiary);
    margin: 0;
  }
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  &:last-child {
    margin-bottom: 0;
  }

  &--inline {
    gap: 24px;
  }
}

.form-label {
  width: 140px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.form-input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;

  &:focus {
    border-color: var(--color-accent);
  }

  &--narrow {
    max-width: 200px;
  }
}

.form-select {
  height: 30px;
  padding: 0 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;
  min-width: 200px;

  &:focus {
    border-color: var(--color-accent);
  }
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.form-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.form-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input {
    cursor: pointer;
  }
}

.btn--small {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
}

.action-bar {
  display: flex;
  gap: 8px;
}

.progress-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.error-msg {
  font-size: 12px;
  color: var(--color-error);
}

.result-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
}

.result-table-wrap {
  overflow-x: auto;
}

.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  &__th {
    text-align: left;
    padding: 8px 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-secondary);
    font-weight: 600;
    white-space: nowrap;
  }

  &__td {
    padding: 8px 10px;
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-primary);
    white-space: nowrap;

    &--score {
      color: var(--color-accent);
      font-weight: 600;
    }

    &--path {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: monospace;
      color: var(--color-success);
    }
  }
}
.empty-section {
  padding: 4px 0;
}
.empty-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  padding: 8px 0;
}
</style>
