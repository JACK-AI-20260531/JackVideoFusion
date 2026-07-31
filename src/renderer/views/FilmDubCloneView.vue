<script setup lang="ts">
/**
 * 影视解说克隆视图
 *
 * 职责:参考视频镜头节奏 → 匹配自有素材 → 复刻节奏+替换画面+自定义配音字幕 → 成片
 *
 * 调用 IPC:
 *   film-dub-clone:start         - 启动克隆任务
 *   film-dub-clone:cancel        - 取消任务
 *   film-dub-clone:previewRhythm - 节奏预览(仅提取参考视频镜头节奏)
 *   material:listFolders         - 加载已注册文件夹
 *   material:addFolder           - 添加文件夹
 *   material:scanFolder          - 扫描素材
 *   dialog:openFile              - 选择参考视频
 *   dialog:openDirectory         - 选择输出目录
 *   common:listResolutions       - 加载分辨率列表
 *   task:progress                - 订阅任务进度推送
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useMaterialStore } from '../stores/material';
import { useConfigStore } from '../stores/config';
import ProgressBar from './material-process/ProgressBar.vue';
import WatermarkEditor from '../components/WatermarkEditor.vue';
import SubtitleEditor from '../components/SubtitleEditor.vue';
import type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  SubtitleStyleConfig,
  WatermarkPosition,
  TaskStatus,
} from '@shared/types';

// 素材仓库
const materialStore = useMaterialStore();
// 配置仓库(用于默认值)
const configStore = useConfigStore();

// ===== 表单参数 =====
// 参考视频路径
const referenceVideoPath = ref('');
// 解说文案
const script = ref('');
// 选中的素材文件夹 ID(单选)
const selectedFolderId = ref<string>('');
// 分辨率预设
const resolution = ref<ResolutionPreset>('1080p');
// 是否保留原画质
const keepOriginalQuality = ref(true);
// 是否生成 TTS 配音
const generateTts = ref(false);
// TTS 语音短名
const ttsVoice = ref('zh-CN-XiaoxiaoNeural');
// 输出目录
const outputDir = ref('');
// 输出文件名
const outputName = ref('');

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

// 字幕配置(用文案作为字幕内容)
const subtitleEnabled = ref(false);
const subtitleStyle = ref<SubtitleStyleConfig>({
  enabled: true,
  fontFamily: '微软雅黑',
  fontSize: 24,
  color: '#ffffff',
  outline: true,
  shadow: false,
  align: 'center',
});

// 分辨率列表(从主进程获取)
const resolutions = ref<ResolutionInfo[]>([]);

// 节奏预览结果
interface RhythmPreview {
  /** 镜头数 */
  shotCount: number;
  /** 平均镜头时长(秒) */
  avgShotDuration: number;
  /** 总时长(秒) */
  totalDuration: number;
  /** 剪辑点数 */
  cutCount: number;
}
const rhythmPreview = ref<RhythmPreview | null>(null);
const previewing = ref(false);

// 输出文件路径(完成后显示)
const outputPath = ref('');

// 任务执行状态
const running = ref(false);
const progress = ref(0);
const error = ref<string | null>(null);
const currentTaskId = ref<string | null>(null);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(参考视频 + 文件夹 + 未运行;启用 TTS 时文案必填)
const canStart = computed(
  () =>
    referenceVideoPath.value.trim().length > 0 &&
    selectedFolderId.value.length > 0 &&
    !running.value &&
    (!generateTts.value || script.value.trim().length > 0),
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

// film-dub-clone:start IPC 返回结构
interface CloneStartResp {
  taskId: string;
  result: {
    outputPath: string;
    durationSec: number;
    segmentCount: number;
  };
}

// 进度订阅取消函数
let unsubscribe: (() => void) | null = null;

/**
 * 组件挂载时加载文件夹列表、分辨率列表、配置
 */
onMounted(async () => {
  // IPC 调用做错误兜底:主进程未就绪或调用失败时静默降级
  try {
    await Promise.all([
      materialStore.loadFolders(),
      configStore.load(),
    ]);
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
 * 选择参考视频文件
 */
async function handlePickReference(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFile', {
    title: '选择参考视频',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] }],
  });
  if (res.ok && res.data && res.data.length > 0) {
    referenceVideoPath.value = res.data[0];
    rhythmPreview.value = null;
  }
}

/**
 * 预览参考视频节奏:调用 film-dub-clone:previewRhythm
 */
async function handlePreviewRhythm(): Promise<void> {
  if (referenceVideoPath.value.trim().length === 0) return;
  previewing.value = true;
  rhythmPreview.value = null;
  error.value = null;
  try {
    const res = await getApi().invoke<{ videoPath: string }, RhythmPreview>(
      'film-dub-clone:previewRhythm',
      { videoPath: referenceVideoPath.value },
    );
    if (res.ok && res.data) {
      rhythmPreview.value = res.data;
    } else {
      error.value = res.error ?? '节奏提取失败';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    previewing.value = false;
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
 * 添加素材文件夹:打开目录选择对话框 → 注册 → 扫描
 */
async function handleAddFolder(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择素材文件夹',
  });
  if (!res.ok || !res.data) return;
  const folder = await materialStore.registerFolder(res.data);
  if (folder) {
    await materialStore.scanFolder(folder.id);
  }
}

/**
 * 刷新文件夹素材列表
 * @param folderId 文件夹 ID
 */
async function handleScanFolder(folderId: string): Promise<void> {
  await materialStore.scanFolder(folderId);
}

/**
 * 开始影视解说克隆
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  outputPath.value = '';
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
    // 构造克隆参数
    const params = {
      referenceVideoPath: referenceVideoPath.value,
      folderId: selectedFolderId.value,
      script: script.value,
      resolution: resolution.value,
      keepOriginalQuality: keepOriginalQuality.value,
      generateTts: generateTts.value,
      ttsVoice: generateTts.value ? ttsVoice.value : undefined,
      watermark: watermarkConfig.value.enabled ? watermarkConfig.value : null,
      subtitle: { enabled: subtitleEnabled.value, style: subtitleStyle.value },
      outputDir: outputDir.value,
      outputName: outputName.value || `film-dub-clone-${Date.now()}.mp4`,
    };

    const res = await getApi().invoke<typeof params, CloneStartResp>(
      'film-dub-clone:start',
      params,
    );
    if (res.ok && res.data) {
      currentTaskId.value = res.data.taskId;
      outputPath.value = res.data.result.outputPath;
      progress.value = 100;
      running.value = false;
    } else {
      error.value = res.error ?? '影视解说克隆失败';
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
 * 取消当前克隆任务
 */
async function handleCancel(): Promise<void> {
  if (!currentTaskId.value) return;
  await getApi().invoke<{ taskId: string }, { cancelled: string }>(
    'film-dub-clone:cancel',
    { taskId: currentTaskId.value },
  );
  running.value = false;
  currentTaskId.value = null;
}
</script>

<template>
  <div class="film-dub-view">
    <!-- 页面标题 -->
    <div class="film-dub-view__header">
      <h2 class="film-dub-view__title">影视解说克隆</h2>
      <p class="film-dub-view__desc">
        复刻参考解说视频的镜头节奏,用自有素材替换画面,配合自定义配音与字幕,生成全新原创解说视频
      </p>
    </div>

    <!-- 参考视频选择 + 节奏预览 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">参考视频(提取镜头节奏)</h3>
        <button
          class="btn btn--small"
          :disabled="previewing || referenceVideoPath.trim().length === 0"
          @click="handlePreviewRhythm"
        >{{ previewing ? '提取中...' : '预览节奏' }}</button>
      </div>
      <div class="form-row">
        <div class="form-input-group">
          <input
            v-model="referenceVideoPath"
            class="form-input"
            placeholder="请选择参考视频文件"
            readonly
          />
          <button class="btn btn--small" @click="handlePickReference">选择视频</button>
        </div>
      </div>
      <div v-if="rhythmPreview" class="rhythm-info">
        <div class="rhythm-info__item">
          <span class="rhythm-info__label">镜头数</span>
          <span class="rhythm-info__value">{{ rhythmPreview.shotCount }}</span>
        </div>
        <div class="rhythm-info__item">
          <span class="rhythm-info__label">平均时长</span>
          <span class="rhythm-info__value">{{ rhythmPreview.avgShotDuration.toFixed(2) }}s</span>
        </div>
        <div class="rhythm-info__item">
          <span class="rhythm-info__label">总时长</span>
          <span class="rhythm-info__value">{{ rhythmPreview.totalDuration.toFixed(2) }}s</span>
        </div>
        <div class="rhythm-info__item">
          <span class="rhythm-info__label">剪辑点</span>
          <span class="rhythm-info__value">{{ rhythmPreview.cutCount }}</span>
        </div>
      </div>
    </section>

    <!-- 解说文案输入区 -->
    <section class="form-section">
      <h3 class="section-title">解说文案</h3>
      <textarea
        v-model="script"
        class="form-textarea"
        placeholder="请输入解说文案,将用于配音与字幕。例如:&#10;这部电影讲述了一个关于成长的故事。&#10;主角在困境中不断寻找自我。&#10;最终他找到了属于自己的方向。"
        rows="6"
      />
    </section>

    <!-- 素材文件夹选择(单选) -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">素材文件夹(单选,画面来源)</h3>
        <button class="btn btn--small" @click="handleAddFolder">+ 添加文件夹</button>
      </div>
      <div v-if="materialStore.folders.length === 0" class="empty-hint">
        暂无文件夹,请点击「添加文件夹」导入素材
      </div>
      <div v-else class="folder-list">
        <label
          v-for="folder in materialStore.folders"
          :key="folder.id"
          class="folder-item"
          :class="{ 'folder-item--active': selectedFolderId === folder.id }"
        >
          <input
            type="radio"
            :checked="selectedFolderId === folder.id"
            @change="selectedFolderId = folder.id"
          />
          <span class="folder-item__name">{{ folder.name }}</span>
          <span class="folder-item__count">{{ folder.materialCount }} 个素材</span>
          <button
            class="btn btn--small folder-item__refresh"
            @click.stop="handleScanFolder(folder.id)"
          >刷新</button>
        </label>
      </div>
    </section>

    <!-- 输出参数 -->
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
        <label class="form-label">输出文件名</label>
        <input v-model="outputName" class="form-input form-input--narrow" placeholder="留空则自动命名" />
      </div>
    </section>

    <!-- 配音设置 -->
    <section class="form-section">
      <h3 class="section-title">配音(TTS)</h3>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="generateTts" type="checkbox" /> 生成配音(用文案合成 TTS 音频)
        </label>
      </div>
      <div v-if="generateTts" class="form-row">
        <label class="form-label">TTS 语音</label>
        <input v-model="ttsVoice" class="form-input form-input--narrow" placeholder="zh-CN-XiaoxiaoNeural" />
        <span class="form-hint">默认 zh-CN-XiaoxiaoNeural(中文女声)</span>
      </div>
    </section>

    <!-- 字幕 -->
    <section class="form-section">
      <h3 class="section-title">字幕(用文案作为字幕)</h3>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="subtitleEnabled" type="checkbox" /> 启用字幕烧录
        </label>
      </div>
      <div v-if="subtitleEnabled" class="subtitle-block">
        <SubtitleEditor v-model="subtitleStyle" />
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
        {{ running ? '克隆中...' : '开始克隆' }}
      </button>
      <button class="btn" :disabled="!running" @click="handleCancel">取消</button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果 -->
    <section v-if="outputPath" class="result-section">
      <h3 class="section-title">克隆完成</h3>
      <div class="result-path" :title="outputPath">{{ outputPath }}</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.film-dub-view {
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

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 12px;

  .section-header & {
    margin: 0;
  }
}

.empty-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  padding: 8px 0;
}

.folder-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;

  &:hover {
    border-color: var(--color-border-strong);
  }

  &--active {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }

  &__name {
    flex: 1;
    color: var(--color-text-primary);
  }

  &__count {
    color: var(--color-text-tertiary);
    font-size: 11px;
  }

  &__refresh {
    margin-left: 4px;
  }
}

.rhythm-info {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 12px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;

  &__item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__label {
    font-size: 11px;
    color: var(--color-text-tertiary);
  }

  &__value {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-accent);
    font-variant-numeric: tabular-nums;
  }
}

.form-textarea {
  width: 100%;
  min-height: 120px;
  padding: 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  line-height: 1.6;

  &:focus {
    border-color: var(--color-accent);
  }
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  &--inline {
    gap: 24px;
  }
}

.form-label {
  width: 110px;
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
    max-width: 240px;
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

.subtitle-block {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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

.result-path {
  font-size: 12px;
  color: var(--color-success);
  font-family: monospace;
  word-break: break-all;
}
</style>
