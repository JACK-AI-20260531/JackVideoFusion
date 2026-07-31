<script setup lang="ts">
/**
 * 素材分割 Tab
 * 职责:按固定时长分割视频;参数:单片段时长、保留原画质、去原声、命名规则
 * 调用 IPC:ffmpeg:split
 */
import { ref, computed } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useMaterialActions } from './useMaterialActions';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认值)
const configStore = useConfigStore();
// 共享动作 composable
const { running, progress, error, pickFile, pickDirectory, runTask } = useMaterialActions();

// ===== 表单参数 =====
// 输入视频文件路径
const inputPath = ref('');
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');
// 单片段时长(秒)
const segmentSec = ref(10);
// 保留原画质
const keepQuality = ref(configStore.config.keepOriginalQuality);
// 去原声
const stripAudio = ref(false);
// 命名规则模板({name}=原文件名, {index}=序号)
const namingRule = ref('{name}_{index}');

// ===== 结果列表 =====
interface SplitResult {
  index: number;
  path: string;
  name: string;
}
const results = ref<SplitResult[]>([]);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(需选择输入文件和输出目录)
const canStart = computed(() => !!inputPath.value && !!outputDir.value && !running.value);

// 拖拽高亮状态
const isDragOver = ref(false);

// 允许的视频扩展名
const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'flv'];

/**
 * 选择输入视频文件
 */
async function handlePickFile(): Promise<void> {
  const path = await pickFile([{ name: '视频文件', extensions: videoExtensions }]);
  if (path) inputPath.value = path;
}

/**
 * 拖拽进入:阻止默认行为,高亮拖拽区
 */
function handleDragEnter(e: DragEvent): void {
  e.preventDefault();
  isDragOver.value = true;
}

/**
 * 拖拽离开:取消高亮
 */
function handleDragLeave(e: DragEvent): void {
  e.preventDefault();
  isDragOver.value = false;
}

/**
 * 拖拽悬停:阻止默认行为(必须,否则 drop 不触发)
 */
function handleDragOver(e: DragEvent): void {
  e.preventDefault();
}

/**
 * 拖拽释放:获取文件路径,校验扩展名后填充
 */
function handleDrop(e: DragEvent): void {
  e.preventDefault();
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // Electron 环境下 file.path 为文件绝对路径
  const filePath = (file as File & { path?: string }).path;
  if (!filePath) return;
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!videoExtensions.includes(ext)) return;
  inputPath.value = filePath;
}

/**
 * 选择输出目录
 */
async function handlePickDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 开始分割:调用 ffmpeg:split IPC
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  results.value = [];

  const res = await runTask<{ segments: string[] }>('material-split', `素材分割: ${inputPath.value}`, 'ffmpeg:split', {
    input: inputPath.value,
    segmentSec: segmentSec.value,
    outputDir: outputDir.value,
    keepQuality: keepQuality.value,
    stripAudio: stripAudio.value,
    namingRule: namingRule.value,
  });

  if (res.ok && res.data) {
    // 将返回的片段路径列表转为结果项
    const segments = res.data.segments ?? [];
    results.value = segments.map((p, i) => ({
      index: i + 1,
      path: p,
      name: p.split(/[\\/]/).pop() ?? p,
    }));
  }
}
</script>

<template>
  <div class="split-tab">
    <!-- 参数表单(支持拖拽视频文件到输入框) -->
    <section
      class="form-section"
      :class="{ 'form-section--drag': isDragOver }"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover="handleDragOver"
      @drop="handleDrop"
    >
      <h3 class="form-section__title">参数设置</h3>
      <div class="form-row">
        <label class="form-label">输入视频</label>
        <div class="form-input-group">
          <input
            v-model="inputPath"
            class="form-input"
            :class="{ 'form-input--drag': isDragOver }"
            placeholder="请选择视频文件或拖拽到此处"
            readonly
          />
          <button class="btn" @click="handlePickFile">选择</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">输出目录</label>
        <div class="form-input-group">
          <input v-model="outputDir" class="form-input" placeholder="请选择输出目录" readonly />
          <button class="btn" @click="handlePickDir">选择</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">单片段时长(秒)</label>
        <input v-model.number="segmentSec" type="number" min="1" class="form-input form-input--narrow" />
      </div>
      <div class="form-row">
        <label class="form-label">命名规则</label>
        <input v-model="namingRule" class="form-input form-input--narrow" placeholder="{name}_{index}" />
        <span class="form-hint">{name}=原文件名, {index}=序号</span>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="keepQuality" type="checkbox" /> 保留原画质
        </label>
        <label class="form-checkbox">
          <input v-model="stripAudio" type="checkbox" /> 去原声
        </label>
      </div>
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '分割中...' : '开始分割' }}
      </button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="results.length > 0" class="result-section">
      <h3 class="result-section__title">分割结果({{ results.length }} 个片段)</h3>
      <div class="result-list">
        <div v-for="item in results" :key="item.index" class="result-item">
          <span class="result-item__index">{{ item.index }}</span>
          <span class="result-item__name" :title="item.path">{{ item.name }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.split-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
  transition: border-color 0.2s, background 0.2s;

  &--drag {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0 0 12px;
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

  &:focus { border-color: var(--color-accent); }

  &--narrow { max-width: 240px; }

  &--drag { border-color: var(--color-accent); }
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

  input { cursor: pointer; }
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

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0 0 8px;
  }
}

.result-list {
  max-height: 240px;
  overflow-y: auto;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--color-text-secondary);

  &__index {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent-soft);
    color: var(--color-accent);
    border-radius: 4px;
    font-size: 11px;
    flex-shrink: 0;
  }

  &__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
