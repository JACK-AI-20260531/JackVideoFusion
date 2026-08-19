<script setup lang="ts">
/**
 * 素材分割 Tab
 * 职责:按固定时长分割视频(支持批量导入多文件,循环逐个调用 ffmpeg:split)
 * 参数:单片段时长、保留原画质、去原声、命名规则
 * 调用 IPC:ffmpeg:split
 */
import { ref, computed, watch } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useMaterialActions, apiInvoke } from './useMaterialActions';
import { applyPreset } from '../../utils/apply-preset';
import { createManifestFilename, downloadManifest } from '../../utils/export-manifest';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认值)
const configStore = useConfigStore();
// 共享动作 composable(含 running/progress/error/pickFiles/pickDirectory/showInFolder/copyPath/addDirToLibrary/runTask)
const { running, progress, error, pickFiles, pickDirectory, showInFolder, copyPath, copyAllPaths, runTask, addDirToLibrary } = useMaterialActions();

// ===== 表单参数 =====
// 批量输入视频文件路径列表
const inputPaths = ref<string[]>([]);
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');
// 单片段时长(秒)
const segmentSec = ref(10);
// 保留原画质(与模板 split.keepQuality 一致)
const keepQuality = ref(configStore.config.split?.keepQuality ?? true);
// 去原声
const stripAudio = ref(false);
// 命名规则模板({name}=原文件名, {index}=序号)
const namingRule = ref('{name}_{index}');

// 从模板套用分割参数到表单(组件创建早期执行一次,applyPreset 只覆盖默认值中已有且类型一致的键)
const splitApplied = applyPreset(
  {
    segmentSec: segmentSec.value,
    keepQuality: keepQuality.value,
    stripAudio: stripAudio.value,
    namingRule: namingRule.value,
  },
  configStore.config.split as Record<string, unknown>,
);
segmentSec.value = splitApplied.segmentSec;
keepQuality.value = splitApplied.keepQuality;
stripAudio.value = splitApplied.stripAudio;
namingRule.value = splitApplied.namingRule;

// ===== 结果列表 =====
interface SplitResult {
  source: string; // 源文件名
  index: number; // 片段序号
  path: string; // 片段文件路径
  name: string; // 片段文件名
  error?: string; // 分割失败时的错误信息
}
const results = ref<SplitResult[]>([]);

// 已加入素材库的路径记录
const libAdded = ref<Record<string, boolean>>({});

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(需选择输入文件且选择输出目录)
const canStart = computed(() => inputPaths.value.length > 0 && !!outputDir.value && !running.value);

// 拖拽高亮状态
const isDragOver = ref(false);

// 允许的视频扩展名
const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'flv'];

/**
 * 追加路径到输入列表并去重
 * @param paths 新加入的路径数组
 */
function appendInputs(paths: string[]): void {
  const existing = new Set(inputPaths.value);
  const added: string[] = [];
  for (const p of paths) {
    if (!existing.has(p)) {
      existing.add(p);
      added.push(p);
    }
  }
  if (added.length > 0) {
    inputPaths.value = [...inputPaths.value, ...added];
  }
}

/**
 * 批量选择视频文件(追加合并,自动去重)
 */
async function handlePickFiles(): Promise<void> {
  const paths = await pickFiles([{ name: '视频文件', extensions: videoExtensions }]);
  if (paths.length > 0) appendInputs(paths);
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
    appendInputs(res.data);
    if (res.data.length === 0) {
      error.value = '该目录下未找到视频文件';
    }
  } else {
    error.value = res.error ?? '导入文件夹失败';
  }
}

/**
 * 移除已选输入文件
 * @param i 要移除的列表下标
 */
function handleRemoveInput(i: number): void {
  inputPaths.value.splice(i, 1);
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
 * 拖拽释放:遍历拖入的多个文件/文件夹,收集其中视频文件追加到列表
 */
function handleDrop(e: DragEvent): void {
  e.preventDefault();
  isDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (!files) return;
  const paths: string[] = [];
  // Electron 环境下 file.path 为文件绝对路径
  for (const file of Array.from(files)) {
    const filePath = (file as File & { path?: string }).path;
    if (!filePath) continue;
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (videoExtensions.includes(ext)) paths.push(filePath);
  }
  if (paths.length > 0) appendInputs(paths);
}

/**
 * 选择输出目录
 */
async function handlePickDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 从文件路径提取不含扩展名的文件名
 * @param filePath 文件路径
 * @returns 文件名(不含扩展名)
 */
function baseName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

/**
 * 开始分割:循环每个输入文件,逐个调用 ffmpeg:split,实时汇总结果
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  results.value = [];

  // 临时汇集数组,循环结束后统一赋值给 results
  const collected: SplitResult[] = [];

  for (const filePath of inputPaths.value) {
    // 源文件名(不含扩展名,用于命名与展示)
    const inputBase = baseName(filePath);
    const res = await runTask<string[]>('material-split', `素材分割: ${inputBase}`, 'ffmpeg:split', {
      input: filePath,
      segmentSec: segmentSec.value,
      outputDir: outputDir.value,
      keepQuality: keepQuality.value,
      stripAudio: stripAudio.value,
      namingRule: namingRule.value,
      inputName: inputBase,
    });

    if (res.ok && res.data) {
      // 后端返回片段路径数组(string[]),映射为结果项
      const segments = Array.isArray(res.data) ? res.data : [];
      for (const p of segments) {
        collected.push({
          source: inputBase,
          index: collected.length + 1,
          path: p,
          name: p.split(/[\\/]/).pop() ?? p,
        });
      }
    } else {
      // 失败条目
      collected.push({
        source: inputBase,
        index: 0,
        path: '',
        name: inputBase,
        error: res.error ?? '分割失败',
      });
    }
  }

  results.value = collected;
}

/**
 * 将片段文件所在目录注册进素材库
 * @param path 文件路径(取所在目录)
 */
async function onAddLibrary(path: string): Promise<void> {
  const r = await addDirToLibrary(path);
  if (r.ok) libAdded.value[path] = true;
}

/**
 * 复制全部片段路径(每行一个)
 */
async function copyAllSegments(): Promise<void> {
  const paths = results.value.filter((r) => r.path).map((r) => r.path);
  await copyAllPaths(paths);
}

/**
 * 导出全部片段路径清单 TXT
 */
function exportSegmentsManifest(): void {
  const paths = results.value.filter((r) => r.path).map((r) => r.path);
  downloadManifest(paths, createManifestFilename('material-split'));
}

// 表单变化同步回 configStore.config.split(供保存模板时带上)
watch(
  [segmentSec, keepQuality, stripAudio, namingRule],
  () => {
    configStore.config.split = {
      segmentSec: segmentSec.value,
      keepQuality: keepQuality.value,
      stripAudio: stripAudio.value,
      namingRule: namingRule.value,
    };
  },
  { deep: false },
);
</script>

<template>
  <div class="split-tab">
    <!-- 参数表单(支持拖拽多个视频/文件夹到拖拽占位区) -->
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
            :value="inputPaths.length > 0 ? `已选 ${inputPaths.length} 个文件` : '请选择视频文件'"
            class="form-input"
            :class="{ 'form-input--drag': isDragOver }"
            placeholder="请选择视频文件或拖拽到此处"
            readonly
          />
          <button class="btn" @click="handlePickFiles" :disabled="running">批量选择</button>
          <button class="btn" @click="handlePickFolder" :disabled="running">导入文件夹</button>
        </div>
      </div>
      <!-- 已选文件列表 -->
      <div v-if="inputPaths.length > 0" class="file-list">
        <div v-for="(f, i) in inputPaths" :key="i" class="file-list__item">
          <span class="file-list__name" :title="f">{{ baseName(f) }}</span>
          <button class="file-list__remove" :disabled="running" @click="handleRemoveInput(i)">✕</button>
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
      <div class="result-section__header">
        <h3 class="result-section__title">分割结果({{ results.length }} 个片段)</h3>
        <div class="result-section__actions">
          <button class="btn--mini" @click="copyAllSegments">复制全部路径</button>
          <button class="btn--mini" @click="exportSegmentsManifest">导出清单</button>
        </div>
      </div>
      <div class="result-list">
        <div v-for="(item, i) in results" :key="i" class="result-item">
          <span class="result-item__source">[{{ item.source }}]</span>
          <span v-if="item.index > 0" class="result-item__index">{{ item.index }}</span>
          <span v-if="item.error" class="result-item__name result-item__name--error">{{ item.error }}</span>
          <span v-else class="result-item__name" :title="item.path">{{ item.name }}</span>
          <template v-if="!item.error">
            <button class="btn btn--mini" @click="showInFolder(item.path)">定位</button>
            <button class="btn btn--mini" @click="copyPath(item.path)">复制</button>
            <button class="btn btn--mini" @click="onAddLibrary(item.path)">{{ libAdded[item.path] ? '已加入' : '加入素材库' }}</button>
          </template>
        </div>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无分割结果,请先选择素材并点击「开始分割」</div>
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
  flex-wrap: wrap;
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

.file-list {
  margin-top: 8px;
  margin-bottom: 12px;
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

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
}

.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--color-text-secondary);

  &__source {
    color: var(--color-text-tertiary);
    font-size: 11px;
    flex-shrink: 0;
  }

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
    flex: 1;

    &--error {
      color: var(--color-error);
      flex: 1;
    }
  }
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
