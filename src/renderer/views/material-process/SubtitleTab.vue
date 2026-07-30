<script setup lang="ts">
/**
 * 字幕提取 Tab
 * 职责:批量导入视频,探测字幕流(ffmpeg:probe),提取并生成 SRT(material-process:extract-subtitle)
 * 前端循环每个文件,逐个调用 IPC,实时更新进度
 */
import { ref, computed } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useMaterialActions, apiInvoke } from './useMaterialActions';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认输出目录)
const configStore = useConfigStore();
// 共享动作 composable(仅用 pickFiles / pickDirectory,runTask 在批量循环中手动调用)
const { pickFiles, pickDirectory } = useMaterialActions();

// ===== 表单参数 =====
// 选中的视频文件列表
const fileList = ref<string[]>([]);
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');

// ===== 执行状态(独立于 composable,因为批量任务需手动控制进度) =====
const running = ref(false);
const progress = ref(0);
const error = ref<string | null>(null);

// ===== 结果列表 =====
interface SubtitleResult {
  file: string;
  status: 'success' | 'failed' | 'skipped';
  srtPath?: string;
  message?: string;
}
const results = ref<SubtitleResult[]>([]);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始
const canStart = computed(() => fileList.value.length > 0 && !!outputDir.value && !running.value);

// 成功/失败计数
const successCount = computed(() => results.value.filter((r) => r.status === 'success').length);
const failedCount = computed(() => results.value.filter((r) => r.status === 'failed').length);

/**
 * 从文件路径提取文件名
 */
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * 从文件路径移除扩展名,返回不含扩展名的路径
 */
function removeExt(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

/**
 * 批量选择视频文件
 */
async function handlePickFiles(): Promise<void> {
  const paths = await pickFiles([{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'mkv'] }]);
  if (paths.length > 0) fileList.value = paths;
}

/**
 * 选择输出目录
 */
async function handlePickDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 移除已选文件
 */
function handleRemoveFile(index: number): void {
  fileList.value.splice(index, 1);
}

/**
 * 开始提取:循环每个文件,先 probe 探测字幕流,再 extract-subtitle 生成 SRT
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;

  running.value = true;
  progress.value = 0;
  error.value = null;
  results.value = [];

  const total = fileList.value.length;
  let done = 0;

  for (const filePath of fileList.value) {
    const fileName = basename(filePath);
    const srtPath = `${outputDir.value}/${removeExt(fileName)}.srt`;

    try {
      // 第1步:探测字幕流(调用 ffmpeg:probe,假设后端返回 streams 信息)
      const probeRes = await apiInvoke<{ filePath: string }, { subtitleStreams: unknown[] }>(
        'ffmpeg:probe',
        { filePath },
      );

      if (!probeRes.ok) {
        results.value.push({ file: fileName, status: 'failed', message: probeRes.error ?? '探测失败' });
      } else if (!probeRes.data?.subtitleStreams || probeRes.data.subtitleStreams.length === 0) {
        // 无字幕流,跳过
        results.value.push({ file: fileName, status: 'skipped', message: '无内嵌字幕流' });
      } else {
        // 第2步:提取字幕(调用 material-process:extract-subtitle)
        const extractRes = await apiInvoke<{ filePath: string; outputPath: string }, string>(
          'material-process:extract-subtitle',
          { filePath, outputPath: srtPath },
        );

        if (extractRes.ok) {
          results.value.push({ file: fileName, status: 'success', srtPath: extractRes.data ?? srtPath });
        } else {
          results.value.push({ file: fileName, status: 'failed', message: extractRes.error ?? '提取失败' });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.value.push({ file: fileName, status: 'failed', message: msg });
    }

    done++;
    progress.value = Math.round((done / total) * 100);
  }

  running.value = false;
}
</script>

<template>
  <div class="subtitle-tab">
    <!-- 文件选择 -->
    <section class="form-section">
      <h3 class="form-section__title">文件选择</h3>
      <div class="form-row">
        <label class="form-label">视频文件</label>
        <div class="form-input-group">
          <input
            :value="fileList.length > 0 ? `已选 ${fileList.length} 个文件` : '请选择视频文件'"
            class="form-input"
            readonly
          />
          <button class="btn" @click="handlePickFiles">批量选择</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">输出目录</label>
        <div class="form-input-group">
          <input v-model="outputDir" class="form-input" placeholder="请选择输出目录" readonly />
          <button class="btn" @click="handlePickDir">选择</button>
        </div>
      </div>

      <!-- 已选文件列表 -->
      <div v-if="fileList.length > 0" class="file-list">
        <div v-for="(f, i) in fileList" :key="i" class="file-list__item">
          <span class="file-list__name" :title="f">{{ basename(f) }}</span>
          <button class="file-list__remove" :disabled="running" @click="handleRemoveFile(i)">✕</button>
        </div>
      </div>
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '提取中...' : '开始提取' }}
      </button>
      <span v-if="results.length > 0" class="result-summary">
        成功 {{ successCount }} / 失败 {{ failedCount }} / 共 {{ results.length }}
      </span>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="results.length > 0" class="result-section">
      <h3 class="result-section__title">提取结果</h3>
      <div class="result-list">
        <div
          v-for="(item, i) in results"
          :key="i"
          class="result-item"
          :class="`result-item--${item.status}`"
        >
          <span class="result-item__status">{{
            item.status === 'success' ? '✓' : item.status === 'failed' ? '✕' : '—'
          }}</span>
          <span class="result-item__file" :title="item.file">{{ item.file }}</span>
          <span v-if="item.message" class="result-item__msg">{{ item.message }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.subtitle-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;

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
}

.form-label {
  width: 80px;
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
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.file-list {
  margin-top: 8px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;

  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--color-bg-sunken);
    border-radius: 4px;
  }

  &__name {
    flex: 1;
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__remove {
    background: transparent;
    border: none;
    color: var(--color-text-tertiary);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 3px;

    &:hover { color: var(--color-error); background: var(--color-bg-hover); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }
}

.action-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.result-summary {
  font-size: 12px;
  color: var(--color-text-tertiary);
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
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--color-bg-sunken);
  border-radius: 4px;
  font-size: 12px;

  &__status {
    width: 18px;
    text-align: center;
    flex-shrink: 0;
    font-weight: 600;
  }

  &__file {
    flex: 1;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__msg {
    color: var(--color-text-tertiary);
    font-size: 11px;
    flex-shrink: 0;
  }

  &--success &__status { color: var(--color-success); }
  &--failed &__status { color: var(--color-error); }
  &--skipped &__status { color: var(--color-text-tertiary); }
}
</style>
