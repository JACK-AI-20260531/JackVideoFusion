<script setup lang="ts">
/**
 * TTS 批量合成 Tab
 * 职责:按行拆分文本为多段,批量调用 tts:synthesizeBatch IPC 生成多个音频
 * 每行(非空)作为一段独立合成,自动按序号命名输出
 */
import { ref, computed } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useTaskStore } from '../../stores/task';
import { useMaterialActions, apiInvoke, apiOn, generateTaskId } from './useMaterialActions';
import { parseTtsProgress } from '../../utils/tts-progress';
import { summarizeTaskOutput } from '../../utils/task-output-summary';
import ProgressBar from './ProgressBar.vue';

const configStore = useConfigStore();
const taskStore = useTaskStore();
const { running, progress, error, pickDirectory, showInFolder, copyPath, addDirToLibrary } = useMaterialActions();

const VOICE_OPTIONS = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓(女声·温柔)' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊(女声·活泼)' },
  { value: 'zh-CN-YunjianNeural', label: '云健(男声·沉稳)' },
  { value: 'zh-CN-YunxiNeural', label: '云希(男声·阳光)' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏(男声·少年)' },
  { value: 'zh-CN-YunyangNeural', label: '云扬(男声·专业)' },
] as const;

const voice = ref<string>('zh-CN-XiaoxiaoNeural');
const rate = ref(0);
const volume = ref(100);
const pitch = ref(0);
const outputDir = ref(configStore.config.defaultExportDir || '');
const generateSrt = ref(true);
const text = ref('');

interface BatchResult {
  index: number;
  audioPath: string;
  srtPath?: string;
}
const results = ref<BatchResult[]>([]);

// 已加入素材库的路径记录
const libAdded = ref<Record<string, boolean>>({});

const MAX_CHARS_PER_LINE = 50000;
const lineCount = computed(() => lines.value.length);
const lines = computed(() =>
  text.value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0),
);

const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

const canStart = computed(() =>
  lineCount.value > 0 && !!outputDir.value && !running.value && !overLimit.value,
);
const overLimit = computed(() => lines.value.some((l) => l.length > MAX_CHARS_PER_LINE));

/**
 * 选择输出目录
 */
async function handlePickDir(): Promise<void> {
  const path = await pickDirectory();
  if (path) outputDir.value = path;
}

/**
 * 开始批量合成:把每行文本打包为独立 TtsParams,调用 tts:synthesizeBatch
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  results.value = [];

  const timestamp = Date.now();
  const items = lines.value.map((line, i) => {
    const base = `${outputDir.value}/tts-${timestamp}-${i + 1}`;
    return {
      text: line,
      voice: voice.value,
      rate: rate.value,
      volume: volume.value,
      pitch: pitch.value,
      outputPath: `${base}.mp3`,
      ...(generateSrt.value ? { srtPath: `${base}.srt` } : {}),
    };
  });

  // 登记批量任务到任务队列
  const taskId = generateTaskId();
  taskStore.enqueue({
    id: taskId,
    type: 'tts-synthesize',
    title: `TTS 批量合成: ${items.length} 段`,
    status: 'running',
    progress: 0,
    params: { items },
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  try {
    running.value = true;
    progress.value = 0;
    error.value = null;

    // 订阅 TTS 合成进度(tts:synthesizeBatch 推送 tts:progress)
    const unsubscribeTts = apiOn('tts:progress', (...args: unknown[]) => {
      const percent = parseTtsProgress(args[0]);
      if (percent != null) {
        progress.value = percent;
        taskStore.updateTask(taskId, { status: 'running', progress: percent });
      }
    });

    try {
      const res = await apiInvoke<
        unknown,
        { audioPath: string; srtPath?: string }[]
      >('tts:synthesizeBatch', items);

      if (res.ok && Array.isArray(res.data)) {
        results.value = res.data.map((r, i) => ({
          index: i + 1,
          audioPath: r.audioPath,
          srtPath: r.srtPath,
        }));
        progress.value = 100;
        taskStore.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          output: summarizeTaskOutput(res.data),
          finishedAt: new Date().toISOString(),
        });
      } else {
        const msg = res.error ?? '合成失败';
        error.value = msg;
        taskStore.updateTask(taskId, {
          status: 'failed',
          error: msg,
          output: summarizeTaskOutput(undefined, msg),
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
      unsubscribeTts();
    }
  } finally {
    running.value = false;
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
</script>

<template>
  <div class="tts-batch-tab">
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

    <section class="form-section">
      <div class="form-section__header">
        <h3 class="form-section__title">批量文本(每行一段)</h3>
        <span class="char-count">{{ lineCount }} 段</span>
      </div>
      <textarea
        v-model="text"
        class="text-area"
        placeholder="每行输入一段待合成的文本,每行将生成一个独立音频文件..."
      />
      <div v-if="overLimit" class="error-msg">存在单行超过 {{ MAX_CHARS_PER_LINE }} 字符</div>
    </section>

    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '合成中...' : '开始批量合成' }}
      </button>
    </div>

    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <section v-if="results.length > 0" class="result-section">
      <h3 class="result-section__title">合成结果({{ results.length }} 段)</h3>
      <div v-for="item in results" :key="item.index" class="result-item">
        <span class="result-item__index">{{ item.index }}</span>
        <span class="result-item__path" :title="item.audioPath">{{ item.audioPath }}</span>
        <template v-if="item.srtPath">
          <span class="result-item__label">字幕:</span>
          <span class="result-item__path" :title="item.srtPath">{{ item.srtPath }}</span>
        </template>
        <button class="btn--mini" @click="showInFolder(item.audioPath)">定位</button>
        <button class="btn--mini" @click="copyPath(item.audioPath)">复制</button>
        <button class="btn--mini" @click="onAddLibrary(item.audioPath)">{{ libAdded[item.audioPath] ? '已加入' : '加入素材库' }}</button>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无合成结果,请先选择文件并点击「开始批量合成」</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.tts-batch-tab {
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
    margin: 0;
  }
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.form-label {
  width: 80px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.form-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;

  &:focus {
    border-color: var(--color-accent);
  }
}

.form-slider {
  flex: 1;
}

.slider-value {
  width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.text-area {
  width: 100%;
  min-height: 160px;
  padding: 10px;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  box-sizing: border-box;

  &:focus {
    border-color: var(--color-accent);
  }
}

.char-count {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.action-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.error-msg {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-error);
}

.result-section {
  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0 0 12px;
  }
}

.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;

  &__index {
    width: 24px;
    text-align: center;
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  &__label {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  &__path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-primary);
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
.empty-section {
  padding: 4px 0;
}
.empty-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  padding: 8px 0;
}
</style>
