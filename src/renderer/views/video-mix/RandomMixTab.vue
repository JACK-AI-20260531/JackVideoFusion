<script setup lang="ts">
/**
 * 随机素材混剪 Tab(模式一)
 * 职责:多文件夹选择 → 各抽 N 条视频片段 → 拼接 → 后处理(水印/字幕)
 * 调用 IPC:video-mix:start(mode='random')、video-mix:pause、video-mix:cancel
 *          material:listFolders、material:addFolder、material:scanFolder
 *          dialog:openDirectory、dialog:openFile、common:listResolutions
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useMaterialStore } from '../../stores/material';
import { useConfigStore } from '../../stores/config';
import { useMixActions, type MixParams } from './useMixActions';
import { applyPreset } from '../../utils/apply-preset';
import ProgressBar from '../material-process/ProgressBar.vue';
import WatermarkEditor from '../../components/WatermarkEditor.vue';
import SubtitleEditor from '../../components/SubtitleEditor.vue';
import type { ResolutionPreset, ResolutionInfo, WatermarkConfig, SubtitleStyleConfig } from '@shared/types';

// 素材仓库(文件夹列表)
const materialStore = useMaterialStore();
// 配置仓库(加载默认值)
const configStore = useConfigStore();
// 混剪动作 composable
const { running, paused, progress, error, start, pause, resume, cancel, pickFile, pickDirectory } = useMixActions();

// ===== 表单参数 =====
// 选中的文件夹 ID 列表(多选)
const selectedFolderIds = ref<string[]>([]);
// 每个文件夹抽取的片段数
const perFolderCount = ref(3);
// 目标总时长(秒),0=不限
const targetDurationSec = ref(0);
// 是否不重复复用素材
const uniqueReuse = ref(true);
// 单片段时长(秒),用于切短分段
const segmentSec = ref(5);
// 分辨率预设
const resolution = ref<ResolutionPreset>('1080p');
// 是否保留原画质
const keepOriginalQuality = ref(false);
// 转场淡化(秒)
const transitionSec = ref(0.5);
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');
// 输出文件名
const outputName = ref('');

// 水印配置
const watermarkConfig = ref<WatermarkConfig>({
  enabled: false,
  type: 'text',
  content: '',
  position: 'bottom-right',
  opacity: 80,
  marginX: 20,
  marginY: 20,
  fontSize: 24,
  fontColor: 'white',
});

// 字幕配置
const subtitleEnabled = ref(false);
const subtitleSrtPath = ref('');
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

// 输出文件路径(完成后显示)
const outputPath = ref('');

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(需选择至少 1 个文件夹 + 未在执行中 + 未暂停)
const canStart = computed(
  () => selectedFolderIds.value.length > 0 && !running.value && !paused.value,
);

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 组件挂载时加载文件夹列表与分辨率列表
 */
onMounted(async () => {
  // 从全局配置模板套用 mix 业务参数到表单(仅创建早期执行一次)
  const mixPreset = configStore.config.mix;
  const fallback = {
    perFolderCount: perFolderCount.value,
    targetDurationSec: targetDurationSec.value,
    uniqueReuse: uniqueReuse.value,
  };
  const v = applyPreset(fallback, mixPreset as Record<string, unknown>);
  perFolderCount.value = v.perFolderCount;
  targetDurationSec.value = v.targetDurationSec;
  uniqueReuse.value = v.uniqueReuse;
  // IPC 调用做错误兜底:主进程未就绪或调用失败时静默降级,
  // 文件夹列表为空、分辨率列表用默认值,保证组件正常渲染
  try {
    await materialStore.loadFolders();
    const res = await getApi().invoke<unknown, ResolutionInfo[]>('common:listResolutions');
    if (res.ok && res.data) {
      resolutions.value = res.data;
    }
  } catch {
    // 降级:保持 resolutions 默认值,不阻断渲染
  }
});

// 监听表单 mix 参数变化,同步回全局配置(供保存模板带上),且不丢字段
watch([perFolderCount, targetDurationSec, uniqueReuse], () => {
  configStore.config.mix = {
    ...configStore.config.mix,
    perFolderCount: perFolderCount.value,
    targetDurationSec: targetDurationSec.value,
    uniqueReuse: uniqueReuse.value,
  };
});

/**
 * 切换文件夹选中状态
 * @param id 文件夹 ID
 */
function toggleFolder(id: string): void {
  const idx = selectedFolderIds.value.indexOf(id);
  if (idx >= 0) {
    selectedFolderIds.value.splice(idx, 1);
  } else {
    selectedFolderIds.value.push(id);
  }
}

/**
 * 添加文件夹:打开目录选择对话框 → 注册 → 扫描
 */
async function handleAddFolder(): Promise<void> {
  const path = await pickDirectory();
  if (!path) return;
  const folder = await materialStore.registerFolder(path);
  if (folder) {
    await materialStore.scanFolder(folder.id);
  }
}

/**
 * 选择输出目录
 */
async function handlePickOutputDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 选择字幕 SRT 文件
 */
async function handlePickSrt(): Promise<void> {
  const path = await pickFile([
    { name: '字幕文件', extensions: ['srt', 'ass', 'ssa'] },
    { name: '所有文件', extensions: ['*'] },
  ]);
  if (path) subtitleSrtPath.value = path;
}

/**
 * 开始混剪:组装 MixParams 调用 start
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  outputPath.value = '';

  const params: MixParams = {
    mode: 'random',
    folderIds: selectedFolderIds.value.slice(),
    perFolderCount: perFolderCount.value,
    targetDurationSec: targetDurationSec.value,
    uniqueReuse: uniqueReuse.value,
    segmentSec: segmentSec.value,
    resolution: resolution.value,
    keepOriginalQuality: keepOriginalQuality.value,
    transitionSec: transitionSec.value,
    watermark: watermarkConfig.value.enabled ? watermarkConfig.value : null,
    subtitle: subtitleEnabled.value && subtitleSrtPath.value
      ? { srtPath: subtitleSrtPath.value, style: subtitleStyle.value }
      : null,
    outputDir: outputDir.value,
    outputName: outputName.value || `random-mix-${Date.now()}.mp4`,
  };

  const res = await start(params);
  if (res.ok && res.data && res.data.result) {
    outputPath.value = res.data.result.outputPath;
  }
}
</script>

<template>
  <div class="mix-tab">
    <!-- 文件夹选择区 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">素材文件夹</h3>
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
          :class="{ 'folder-item--active': selectedFolderIds.includes(folder.id) }"
        >
          <input
            type="checkbox"
            :checked="selectedFolderIds.includes(folder.id)"
            @change="toggleFolder(folder.id)"
          />
          <span class="folder-item__name">{{ folder.name }}</span>
          <span class="folder-item__count">{{ folder.materialCount }} 个素材</span>
        </label>
      </div>
    </section>

    <!-- 混剪参数 -->
    <section class="form-section">
      <h3 class="section-title">混剪参数</h3>
      <div class="form-row">
        <label class="form-label">每文件夹抽取</label>
        <input v-model.number="perFolderCount" type="number" min="1" class="form-input form-input--narrow" />
        <span class="form-hint">条视频</span>
      </div>
      <div class="form-row">
        <label class="form-label">目标总时长</label>
        <input v-model.number="targetDurationSec" type="number" min="0" class="form-input form-input--narrow" />
        <span class="form-hint">秒(0=不限)</span>
      </div>
      <div class="form-row">
        <label class="form-label">单片段时长</label>
        <input v-model.number="segmentSec" type="number" min="0" class="form-input form-input--narrow" />
        <span class="form-hint">秒(切短分段,0=不切)</span>
      </div>
      <div class="form-row">
        <label class="form-label">转场淡化</label>
        <input v-model.number="transitionSec" type="number" min="0" step="0.1" class="form-input form-input--narrow" />
        <span class="form-hint">秒(预留)</span>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="uniqueReuse" type="checkbox" /> 不重复复用素材
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

    <!-- 水印 -->
    <section class="form-section">
      <h3 class="section-title">水印</h3>
      <WatermarkEditor v-model="watermarkConfig" />
    </section>

    <!-- 字幕 -->
    <section class="form-section">
      <h3 class="section-title">字幕</h3>
      <div class="form-row">
        <label class="form-checkbox">
          <input v-model="subtitleEnabled" type="checkbox" /> 启用字幕烧录
        </label>
      </div>
      <div v-if="subtitleEnabled" class="subtitle-block">
        <div class="form-row">
          <label class="form-label">SRT 文件</label>
          <div class="form-input-group">
            <input v-model="subtitleSrtPath" class="form-input" placeholder="请选择 .srt 文件" readonly />
            <button class="btn btn--small" @click="handlePickSrt">选择</button>
          </div>
        </div>
        <SubtitleEditor v-model="subtitleStyle" />
      </div>
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '混剪中...' : '开始混剪' }}
      </button>
      <button v-if="paused" class="btn btn--primary" @click="resume">恢复</button>
      <button class="btn" :disabled="!running" @click="pause">暂停</button>
      <button class="btn" :disabled="!running && !paused" @click="cancel">取消</button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || paused || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果 -->
    <section v-if="outputPath" class="result-section">
      <h3 class="section-title">混剪完成</h3>
      <div class="result-path" :title="outputPath">{{ outputPath }}</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.mix-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

  &--narrow { max-width: 200px; }
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

  &:focus { border-color: var(--color-accent); }
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
