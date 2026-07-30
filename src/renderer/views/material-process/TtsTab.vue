<script setup lang="ts">
/**
 * 微软 TTS Tab
 * 职责:粘贴文本/导入TXT,选择音色(男女声)、语速/音量/音调,调用 tts:synthesize IPC
 * 支持最多 5 万字符输入
 */
import { ref, computed } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useMaterialActions } from './useMaterialActions';
import ProgressBar from './ProgressBar.vue';

// 配置仓库(加载默认输出目录)
const configStore = useConfigStore();
// 共享动作 composable
const { running, progress, error, pickDirectory, runTask } = useMaterialActions();

// 音色选项(微软 Edge TTS 常用中文音色)
const VOICE_OPTIONS = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓(女声·温柔)' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊(女声·活泼)' },
  { value: 'zh-CN-YunjianNeural', label: '云健(男声·沉稳)' },
  { value: 'zh-CN-YunxiNeural', label: '云希(男声·阳光)' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏(男声·少年)' },
  { value: 'zh-CN-YunyangNeural', label: '云扬(男声·专业)' },
] as const;

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

// ===== 结果 =====
interface TtsResult {
  audioPath: string;
  srtPath?: string;
}
const results = ref<TtsResult[]>([]);

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

  const res = await runTask<{ audioPath: string; srtPath?: string }>(
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
    }];
  }
}
</script>

<template>
  <div class="tts-tab">
    <!-- 参数表单 -->
    <section class="form-section">
      <h3 class="form-section__title">参数设置</h3>
      <div class="form-row">
        <label class="form-label">音色</label>
        <select v-model="voice" class="form-input form-input--select">
          <option v-for="v in VOICE_OPTIONS" :key="v.value" :value="v.value">{{ v.label }}</option>
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
      </div>
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
  }
}
</style>
