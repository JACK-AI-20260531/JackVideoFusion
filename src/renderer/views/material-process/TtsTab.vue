<script setup lang="ts">
/**
 * 微软 TTS Tab
 * 职责:粘贴文本/导入TXT,选择音色(男女声)、语速/音量/音调,调用 tts:synthesize IPC
 * 支持最多 5 万字符输入
 */
import { ref, computed, watch, onMounted } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useMaterialActions, apiOn } from './useMaterialActions';
import { parseTtsProgress } from '../../utils/tts-progress';
import { formatDurationSec } from '../../utils/duration';
import { applyPreset } from '../../utils/apply-preset';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认输出目录)
const configStore = useConfigStore();
// 共享动作 composable
const { running, progress, error, pickDirectory, showInFolder, copyPath, runTask, addDirToLibrary } = useMaterialActions();

// 音色选项(微软 Edge TTS 常用中文音色)
const VOICE_OPTIONS = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓(女声·温柔)' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊(女声·活泼)' },
  { value: 'zh-CN-YunjianNeural', label: '云健(男声·沉稳)' },
  { value: 'zh-CN-YunxiNeural', label: '云希(男声·阳光)' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏(男声·少年)' },
  { value: 'zh-CN-YunyangNeural', label: '云扬(男声·专业)' },
] as const;

// 克隆音色选项(语音克隆服务,运行时加载;值为 "clone:{voiceId}" 统一键)
const cloneVoiceOptions = ref<{ value: string; label: string; group: string }[]>([]);
// 合并后的统一音色选项(微软 + 克隆)
const voOptions = computed(() => {
  const base = VOICE_OPTIONS.map((v) => ({ value: v.value, label: v.label, group: '微软' }));
  return [...base, ...cloneVoiceOptions.value];
});

// 加载语音克隆音色列表
async function loadCloneVoices(): Promise<void> {
  try {
    const api = (window as unknown as { api: { invoke: <TReq, TResp>(c: string, p?: TReq) => Promise<{ ok: boolean; data?: TResp; error?: string }> } }).api;
    const res = await api.invoke<unknown, { id: string; name: string }[]>('voice-clone:listVoices');
    if (res.ok && Array.isArray(res.data)) {
      cloneVoiceOptions.value = res.data.map((v) => ({ value: `clone:${v.id}`, label: v.name, group: '克隆' }));
    }
  } catch { /* 忽略音色加载失败 */ }
}
onMounted(() => { loadCloneVoices(); });

// ===== 表单参数 =====
// 待合成文本
const text = ref('');
// 音色
const voice = ref<string>('zh-CN-XiaoxiaoNeural');
// 语速(-100 ~ 100,0 为默认)
const rate = ref(0);
// 音量(0 ~ 100)
const volume = ref(100);
// 音调(-100 ~ 100,0 为默认)
const pitch = ref(0);
// 输出目录
const outputDir = ref(configStore.config.defaultExportDir || '');
// 是否同时生成 SRT 字幕
const generateSrt = ref(true);

// 从模板套用 TTS 参数到表单(仅 voice/generateSrt 与模板字段匹配,rate/volume/pitch 不来自模板保留当前值)
const ttsApplied = applyPreset(
  {
    voice: voice.value,
    generateSrt: generateSrt.value,
  },
  configStore.config.tts as Record<string, unknown>,
);
voice.value = ttsApplied.voice;
generateSrt.value = ttsApplied.generateSrt;

// ===== 结果 =====
interface TtsResult {
  audioPath: string;
  srtPath?: string;
  durationSec?: number;
  charCount?: number;
}
const results = ref<TtsResult[]>([]);

// 已加入素材库的路径记录
const libAdded = ref<Record<string, boolean>>({});

// 文本字数(上限 50000)
const MAX_CHARS = 50000;
const textCount = computed(() => text.value.length);
const overLimit = computed(() => textCount.value > MAX_CHARS);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始
const canStart = computed(() =>
  text.value.trim().length > 0 && !overLimit.value && !!outputDir.value && !running.value,
);

// 隐藏的文件输入(用于导入 TXT)
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * 导入 TXT 文件(浏览器原生 FileReader)
 */
function handleImportTxt(): void {
  fileInput.value?.click();
}

/**
 * 文件选择变更回调:读取 TXT 内容到文本框
 */
function handleFileChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const content = String(reader.result ?? '');
    // 超过 5 万字符时截断
    text.value = content.slice(0, MAX_CHARS);
  };
  reader.readAsText(file, 'UTF-8');
  target.value = '';
}

/**
 * 选择输出目录
 */
async function handlePickDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 开始合成:调用 tts:synthesize IPC
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  results.value = [];

  const timestamp = Date.now();
  const audioPath = `${outputDir.value}/tts-${timestamp}.mp3`;
  const srtPath = generateSrt.value ? `${outputDir.value}/tts-${timestamp}.srt` : '';

  // 订阅 TTS 合成进度(tts:synthesize 推送 tts:progress)
  const unsubscribeTts = apiOn('tts:progress', (...args: unknown[]) => {
    const percent = parseTtsProgress(args[0]);
    if (percent != null) {
      progress.value = percent;
    }
  });

  try {
    const res = await runTask<{ audioPath: string; srtPath?: string; durationSec?: number; charCount?: number }>(
      'tts-synthesize',
      `TTS 合成: ${textCount.value} 字`,
      'tts:synthesize',
      {
        text: text.value,
        voice: voice.value,
        rate: rate.value,
        volume: volume.value,
        pitch: pitch.value,
        outputPath: audioPath,
        srtPath,
      },
    );

    if (res.ok && res.data) {
      results.value = [{
        audioPath: res.data.audioPath ?? audioPath,
        srtPath: res.data.srtPath,
        durationSec: res.data.durationSec,
        charCount: res.data.charCount,
      }];
    }
  } finally {
    unsubscribeTts();
  }
}

/**
 * 将音频文件所在目录注册进素材库
 * @param path 文件路径(取所在目录)
 */
async function onAddLibrary(path: string): Promise<void> {
  const r = await addDirToLibrary(path);
  if (r.ok) libAdded.value[path] = true;
}

// 表单变化同步回 configStore.config.tts(供保存模板时带上)
watch(
  [voice, generateSrt],
  () => {
    configStore.config.tts = {
      voice: voice.value,
      generateSrt: generateSrt.value,
    };
  },
  { deep: false },
);
</script>

<template>
  <div class="tts-tab">
    <!-- 参数表单 -->
    <section class="form-section">
      <h3 class="form-section__title">参数设置</h3>
      <div class="form-row">
        <label class="form-label">音色</label>
        <select v-model="voice" class="form-input form-input--select">
          <option v-for="v in voOptions" :key="v.value" :value="v.value">{{ v.label }}({{ v.group }})</option>
        </select>
      </div>
      <div class="form-row">
        <label class="form-label">语速</label>
        <input v-model.number="rate" type="range" min="-100" max="100" step="10" class="form-slider" />
        <span class="slider-value">{{ rate }}</span>
      </div>
      <div class="form-row">
        <label class="form-label">音量</label>
        <input v-model.number="volume" type="range" min="0" max="100" step="5" class="form-slider" />
        <span class="slider-value">{{ volume }}</span>
      </div>
      <div class="form-row">
        <label class="form-label">音调</label>
        <input v-model.number="pitch" type="range" min="-100" max="100" step="10" class="form-slider" />
        <span class="slider-value">{{ pitch }}</span>
      </div>
      <div class="form-row">
        <label class="form-label">输出目录</label>
        <div class="form-input-group">
          <input v-model="outputDir" class="form-input" placeholder="请选择输出目录" readonly />
          <button class="btn" @click="handlePickDir">选择</button>
        </div>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="generateSrt" type="checkbox" /> 同时生成 SRT 字幕
        </label>
      </div>
    </section>

    <!-- 文本输入 -->
    <section class="form-section">
      <div class="form-section__header">
        <h3 class="form-section__title">文本内容</h3>
        <div class="form-section__actions">
          <span class="char-count" :class="{ 'char-count--over': overLimit }">
            {{ textCount }} / {{ MAX_CHARS }}
          </span>
          <button class="btn btn--small" @click="handleImportTxt">导入 TXT</button>
          <input
            ref="fileInput"
            type="file"
            accept=".txt"
            style="display: none"
            @change="handleFileChange"
          />
        </div>
      </div>
      <textarea
        v-model="text"
        class="text-area"
        :placeholder="`请输入或粘贴待合成的文本(最多 ${MAX_CHARS} 字)...`"
      />
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '合成中...' : '开始合成' }}
      </button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="results.length > 0" class="result-section">
      <h3 class="result-section__title">合成结果</h3>
      <div v-for="(item, i) in results" :key="i" class="result-item">
        <span class="result-item__label">音频:</span>
        <span class="result-item__path" :title="item.audioPath">{{ item.audioPath }}</span>
        <template v-if="item.srtPath">
          <span class="result-item__label">字幕:</span>
          <span class="result-item__path" :title="item.srtPath">{{ item.srtPath }}</span>
        </template>
        <button class="btn--mini" @click="showInFolder(item.audioPath)">定位</button>
        <button class="btn--mini" @click="copyPath(item.audioPath)">复制音频</button>
        <button class="btn--mini" @click="onAddLibrary(item.audioPath)">{{ libAdded[item.audioPath] ? '已加入' : '加入素材库' }}</button>
        <span v-if="item.durationSec != null || item.charCount != null" class="result-item__meta">
          <template v-if="item.durationSec != null">时长 {{ formatDurationSec(item.durationSec) }}</template>
          <template v-if="item.charCount != null"> · {{ item.charCount }} 字</template>
        </span>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无合成结果,请先输入文本并点击「合成语音」</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.tts-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0 0 12px;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
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

  &--select { max-width: 280px; cursor: pointer; }
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.form-slider {
  flex: 1;
  max-width: 280px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.slider-value {
  font-size: 11px;
  color: var(--color-text-tertiary);
  min-width: 32px;
  font-variant-numeric: tabular-nums;
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

.char-count {
  font-size: 11px;
  color: var(--color-text-tertiary);

  &--over { color: var(--color-error); }
}

.text-area {
  width: 100%;
  min-height: 180px;
  padding: 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.6;
  font-family: var(--font-family);
  resize: vertical;
  outline: none;

  &:focus { border-color: var(--color-accent); }
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

.result-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--color-text-secondary);

  &__label {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  &__path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
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

.result-item__meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
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
