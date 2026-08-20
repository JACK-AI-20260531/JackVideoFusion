<script setup lang="ts">
/**
 * 字幕提取 Tab
 * 职责:批量导入视频,探测字幕流(ffmpeg:probe),提取并生成 SRT(material-process:extract-subtitle)
 * 前端循环每个文件,逐个调用 IPC,实时更新进度
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useTaskStore } from '../../stores/task';
import { useMaterialActions, apiInvoke, apiOn, generateTaskId } from './useMaterialActions';
import { summarizeTaskOutput } from '../../utils/task-output-summary';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认输出目录)
const configStore = useConfigStore();
const taskStore = useTaskStore();
// 共享动作 composable(仅用 pickFiles / pickDirectory,runTask 在批量循环中手动调用)
const { pickFiles, pickDirectory, error: pickError, showInFolder, copyPath, copyAllPaths, addDirToLibrary } = useMaterialActions();

// ===== 表单参数 =====
// 选中的视频文件列表
const fileList = ref<string[]>([]);
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');
// 无内嵌字幕流时,是否用 OCR 识别画面文字作为兜底
const ocrFallback = ref(false);
// 当前 OCR 识别的细粒度进度(0-100)与阶段文案
const ocrProgress = ref(0);
const ocrPhase = ref('');
// 当前 OCR 请求 id(用于关联进度事件)
let ocrReqId = '';
// 事件退订函数
let unsubscribeOcrProgress: (() => void) | null = null;

// ===== 执行状态(独立于 composable,因为批量任务需手动控制进度) =====
const running = ref(false);
const cancelled = ref(false);
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

// 已加入素材库的路径记录
const libAdded = ref<Record<string, boolean>>({});

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value || pickError.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始
const canStart = computed(() => fileList.value.length > 0 && !!outputDir.value && !running.value);

// 成功/失败计数
const successCount = computed(() => results.value.filter((r) => r.status === 'success').length);
const hasSuccessSrt = computed(() =>
  results.value.some((r) => r.status === 'success' && !!r.srtPath),
);
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
 * 追加路径到文件列表并去重
 * @param paths 新加入的路径数组
 */
function appendFiles(paths: string[]): void {
  const existing = new Set(fileList.value);
  const added: string[] = [];
  for (const p of paths) {
    if (!existing.has(p)) {
      existing.add(p);
      added.push(p);
    }
  }
  if (added.length > 0) {
    fileList.value = [...fileList.value, ...added];
  }
}

/**
 * 批量选择视频文件(追加合并,自动去重)
 */
async function handlePickFiles(): Promise<void> {
  const paths = await pickFiles([{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv'] }]);
  if (paths.length > 0) appendFiles(paths);
}

/**
 * 导入整个文件夹:列出目录下视频文件后追加到列表(自动去重)
 */
async function handlePickFolder(): Promise<void> {
  const dir = await pickDirectory();
  if (!dir) return;
  const res = await apiInvoke<{ dirPath: string }, string[]>(
    'material-process:list-video-files',
    { dirPath: dir },
  );
  if (res.ok && Array.isArray(res.data)) {
    appendFiles(res.data);
    if (res.data.length === 0) {
      error.value = '该目录下未找到视频文件';
    }
  } else {
    error.value = res.error ?? '导入文件夹失败';
  }
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
  cancelled.value = false;
  progress.value = 0;
  error.value = null;
  results.value = [];

  const total = fileList.value.length;
  let done = 0;

  // 登记批量任务到任务队列,与其他素材处理页保持一致
  const taskId = generateTaskId();
  taskStore.enqueue({
    id: taskId,
    type: 'subtitle-extract',
    title: `字幕提取: ${total} 个文件`,
    status: 'running',
    progress: 0,
    params: { fileList: fileList.value, outputDir: outputDir.value },
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  try {
    for (const filePath of fileList.value) {
      // 取消检查:若用户取消则停止处理后续文件
      if (cancelled.value) break;
      const fileName = basename(filePath);
      const srtPath = `${outputDir.value}/${removeExt(fileName)}.srt`;

      try {
        // 第1步:探测字幕流(调用 ffmpeg:probe,后端返回 streams 信息)
        const probeRes = await apiInvoke<{ filePath: string }, { subtitleStreams: unknown[] }>(
          'ffmpeg:probe',
          { filePath },
        );

        if (!probeRes.ok) {
          results.value.push({ file: fileName, status: 'failed', message: probeRes.error ?? '探测失败' });
        } else if (!probeRes.data?.subtitleStreams || probeRes.data.subtitleStreams.length === 0) {
          // 无内嵌字幕流
          if (ocrFallback.value) {
            // 用 OCR 识别画面文字作为兜底(带 requestId 关联进度)
            ocrReqId = `ocr-${Date.now()}-${filePath}`;
            ocrProgress.value = 0;
            ocrPhase.value = '准备中';
            const ocrRes = await apiInvoke<
              { videoPath: string; outputPath: string; requestId: string },
              string
            >('material-process:extract-subtitle-ocr', {
              videoPath: filePath,
              outputPath: srtPath,
              requestId: ocrReqId,
            });
            ocrProgress.value = 100;
            ocrPhase.value = '';
            if (ocrRes.ok) {
              results.value.push({ file: fileName, status: 'success', srtPath: ocrRes.data ?? srtPath, message: 'OCR 识别' });
            } else {
              results.value.push({ file: fileName, status: 'failed', message: `OCR 识别失败: ${ocrRes.error ?? ''}` });
            }
          } else {
            results.value.push({ file: fileName, status: 'skipped', message: '无内嵌字幕流' });
          }
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
      taskStore.updateTask(taskId, { status: 'running', progress: progress.value });
    }

    // 汇总本次批量结果到任务面板(区分正常完成与用户取消)
    const success = results.value.filter((r) => r.status === 'success').length;
    const failed = results.value.filter((r) => r.status === 'failed').length;
    const skipped = results.value.filter((r) => r.status === 'skipped').length;
    const baseSummary =
      failed > 0 ? `${success} 成功 / ${failed} 失败 / ${skipped} 跳过` : `${success} 成功`;
    if (cancelled.value) {
      taskStore.updateTask(taskId, {
        status: 'cancelled',
        progress: progress.value,
        output: `已取消(${baseSummary})`,
        finishedAt: new Date().toISOString(),
      });
    } else {
      taskStore.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        output: baseSummary,
        finishedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error.value = msg;
    taskStore.updateTask(taskId, {
      status: 'failed',
      error: msg,
      output: summarizeTaskOutput(undefined, msg),
      finishedAt: new Date().toISOString(),
    });
  } finally {
    running.value = false;
  }
}

/**
 * 取消当前批量提取:中断进行中的 OCR(若有)并停止处理后续文件,已完成的结果保留
 */
async function handleCancel(): Promise<void> {
  if (!running.value) return;
  cancelled.value = true;
  ocrPhase.value = '取消中';
  // 尝试中断进行中的 OCR 请求(通过主进程取消令牌)
  if (ocrReqId) {
    await apiInvoke<{ requestId: string }, { cancelled: boolean }>(
      'material-process:cancel-ocr',
      { requestId: ocrReqId },
    );
  }
}

/**
 * 将字幕文件所在目录注册进素材库
 * @param path 文件路径(取所在目录)
 */
async function onAddLibrary(path: string): Promise<void> {
  const r = await addDirToLibrary(path);
  if (r.ok) libAdded.value[path] = true;
}

/**
 * 复制全部成功字幕路径(每行一个)
 */
async function copyAllSubtitles(): Promise<void> {
  const paths = results.value
    .filter((r) => r.status === 'success' && r.srtPath)
    .map((r) => r.srtPath as string);
  await copyAllPaths(paths);
}

/**
 * 订阅 OCR 识别进度事件,更新当前文件识别进度(带 requestId 关联)
 */
onMounted(() => {
  unsubscribeOcrProgress = apiOn('material-process:ocr-progress', (...args: unknown[]) => {
    const data = args[0] as { requestId?: string; percent?: number; phase?: string } | undefined;
    if (!data) return;
    // 仅当事件属于当前 OCR 请求时更新
    if (data.requestId && data.requestId !== ocrReqId) return;
    if (typeof data.percent === 'number') ocrProgress.value = data.percent;
    if (typeof data.phase === 'string') ocrPhase.value = data.phase;
  });
});

onUnmounted(() => {
  if (unsubscribeOcrProgress) {
    unsubscribeOcrProgress();
    unsubscribeOcrProgress = null;
  }
});
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
          <button class="btn" @click="handlePickFolder" :disabled="running">导入文件夹</button>
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
      <button v-if="running" class="btn" @click="handleCancel" :disabled="cancelled">取消</button>
      <label class="ocr-toggle" title="视频无内嵌字幕流时,识别画面中的文字并生成字幕(较慢,首次需联网下载识别引擎)">
        <input v-model="ocrFallback" type="checkbox" :disabled="running" />
        <span>无字幕流时用 OCR 识别画面文字</span>
      </label>
      <span v-if="running && ocrPhase" class="ocr-status">OCR {{ ocrPhase }} {{ ocrProgress }}%</span>
      <span v-if="results.length > 0" class="result-summary">
        成功 {{ successCount }} / 失败 {{ failedCount }} / 共 {{ results.length }}
      </span>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error || pickError" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error || pickError" class="error-msg">{{ error || pickError }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="results.length > 0" class="result-section">
      <div class="result-section__header">
        <h3 class="result-section__title">提取结果</h3>
        <button class="btn--mini" :disabled="!hasSuccessSrt" @click="copyAllSubtitles">复制全部字幕路径</button>
      </div>
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
          <button
            v-if="item.status === 'success' && item.srtPath"
            class="btn--mini"
            @click="showInFolder(item.srtPath)"
          >定位字幕</button>
          <button
            v-if="item.status === 'success' && item.srtPath"
            class="btn--mini"
            @click="copyPath(item.srtPath)"
          >复制字幕路径</button>
          <button
            v-if="item.status === 'success' && item.srtPath"
            class="btn--mini"
            @click="onAddLibrary(item.srtPath)"
          >{{ libAdded[item.srtPath] ? '已加入' : '加入素材库' }}</button>
        </div>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无提取结果,请先选择视频并点击「开始提取」</div>
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
  flex-wrap: wrap;
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

.ocr-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;

  input {
    cursor: pointer;
    accent-color: var(--color-accent);
  }

  &:has(input:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.ocr-status {
  font-size: 12px;
  color: var(--color-accent);
  white-space: nowrap;
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

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0;
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

.btn--mini {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
  cursor: pointer;

  &:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    &:hover {
      border-color: var(--color-border-default);
      color: var(--color-text-secondary);
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
