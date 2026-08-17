<script setup lang="ts">
/**
 * 语音克隆视图
 * 职责:GPT-SoVITS 服务管理 + 音色库管理 + 克隆 TTS 合成
 * 调用 IPC:voice-clone:listVoices/cloneSample/deleteVoice/synthesize/checkService/startService/stopService
 *          dialog:openFile/openDirectory
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import ProgressBar from './material-process/ProgressBar.vue';

// ===== 类型定义(与主进程 types.ts 保持一致) =====
type CloneLanguage = 'zh' | 'en' | 'jp' | 'kr' | 'auto';

interface ClonedVoice {
  id: string;
  name: string;
  samplePath: string;
  refAudioPath: string;
  refText: string;
  language: CloneLanguage;
  createdAt: string;
}

type GptSoVitsStatus = 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';

interface GptSoVitsConfig {
  installPath: string;
  port: number;
  modelPath?: string;
  sovitsModelPath?: string;
  pythonPath?: string;
}

interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

// ===== 服务状态 =====
const serviceStatus = ref<GptSoVitsStatus>('stopped');
const serviceLoading = ref(false);
const installPath = ref('');
const servicePort = ref(9880);
const statusText = computed(() => {
  const map: Record<GptSoVitsStatus, string> = {
    'not-installed': '未安装',
    'stopped': '已停止',
    'starting': '启动中',
    'running': '运行中',
    'error': '错误',
  };
  return map[serviceStatus.value];
});

// 状态指示灯颜色(克制使用状态色)
const statusDotClass = computed(() => `status-dot--${serviceStatus.value}`);

// ===== 音色库 =====
const voices = ref<ClonedVoice[]>([]);
const selectedVoiceId = ref('');
const voicesLoading = ref(false);

// 克隆样本表单
const showCloneForm = ref(false);
const cloneForm = ref({
  samplePath: '',
  sampleName: '',
  refText: '',
  language: 'zh' as CloneLanguage,
});
const cloning = ref(false);

// ===== 合成 =====
const synthText = ref('');
const synthOutputDir = ref('');
const synthOutputName = ref('');
const synthSrtEnabled = ref(true);
const synthRate = ref(0);
const synthesizing = ref(false);
const synthProgress = ref(0);
const synthError = ref('');
const synthResult = ref<{ audioPath: string; srtPath?: string } | null>(null);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (synthError.value) return 'failed';
  if (synthesizing.value) return 'running';
  if (synthProgress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可合成
const canSynthesize = computed(
  () =>
    !synthesizing.value &&
    synthText.value.trim().length > 0 &&
    selectedVoiceId.value.length > 0 &&
    synthOutputDir.value.length > 0,
);

// 语言选项
const languageOptions: { value: CloneLanguage; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'jp', label: '日文' },
  { value: 'kr', label: '韩文' },
  { value: 'auto', label: '自动检测' },
];

/**
 * 组件挂载时加载音色库与服务状态
 */
onMounted(async () => {
  // IPC 调用做错误兜底:主进程未就绪时静默降级
  try {
    await loadVoices();
    await checkService();
  } catch {
    // 降级:保持默认状态,不阻断渲染
  }
});

/**
 * 加载音色库列表
 */
async function loadVoices(): Promise<void> {
  voicesLoading.value = true;
  try {
    const res = await getApi().invoke<unknown, ClonedVoice[]>('voice-clone:listVoices');
    if (res.ok && res.data) {
      voices.value = res.data;
      // 默认选中第一个音色
      if (voices.value.length > 0 && !selectedVoiceId.value) {
        selectedVoiceId.value = voices.value[0].id;
      }
    }
  } catch {
    // 静默降级
  } finally {
    voicesLoading.value = false;
  }
}

/**
 * 检查 GPT-SoVITS 服务状态
 */
async function checkService(): Promise<void> {
  serviceLoading.value = true;
  try {
    const res = await getApi().invoke<{ installPath?: string }, GptSoVitsStatus>(
      'voice-clone:checkService',
      { installPath: installPath.value || undefined },
    );
    if (res.ok && res.data) {
      serviceStatus.value = res.data;
    }
  } catch {
    // 静默降级
  } finally {
    serviceLoading.value = false;
  }
}

/**
 * 启动 GPT-SoVITS 服务
 */
async function handleStartService(): Promise<void> {
  if (!installPath.value.trim()) {
    synthError.value = '请先填写 GPT-SoVITS 安装路径';
    return;
  }
  serviceLoading.value = true;
  try {
    const config: GptSoVitsConfig = {
      installPath: installPath.value,
      port: servicePort.value,
    };
    const res = await getApi().invoke<{ config: GptSoVitsConfig }, { started: boolean; status: GptSoVitsStatus }>(
      'voice-clone:startService',
      { config },
    );
    if (res.ok && res.data) {
      serviceStatus.value = res.data.status;
    }
  } catch (err) {
    synthError.value = err instanceof Error ? err.message : String(err);
  } finally {
    serviceLoading.value = false;
  }
}

/**
 * 停止 GPT-SoVITS 服务
 */
async function handleStopService(): Promise<void> {
  serviceLoading.value = true;
  try {
    const res = await getApi().invoke<unknown, { stopped: boolean; status: GptSoVitsStatus }>(
      'voice-clone:stopService',
    );
    if (res.ok && res.data) {
      serviceStatus.value = res.data.status;
    }
  } finally {
    serviceLoading.value = false;
  }
}

/**
 * 选择样本音频文件
 */
async function handlePickSample(): Promise<void> {
  const res = await getApi().invoke<{ title?: string; filters?: unknown }, string>('dialog:openFile', {
    title: '选择样本音频(5-30 秒)',
    filters: [
      { name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'flac'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.ok && res.data) {
    cloneForm.value.samplePath = res.data;
    // 自动填充名称(取文件名)
    if (!cloneForm.value.sampleName) {
      const name = res.data.split(/[\\/]/).pop() || '';
      cloneForm.value.sampleName = name.replace(/\.[^.]+$/, '');
    }
  }
}

/**
 * 选择合成输出目录
 */
async function handlePickOutputDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择输出目录',
  });
  if (res.ok && res.data) {
    synthOutputDir.value = res.data;
  }
}

/**
 * 提交克隆样本
 */
async function handleCloneSample(): Promise<void> {
  if (!cloneForm.value.samplePath || !cloneForm.value.sampleName || !cloneForm.value.refText) {
    synthError.value = '请填写样本路径、名称和参考文本';
    return;
  }
  cloning.value = true;
  synthError.value = '';
  try {
    const res = await getApi().invoke<
      typeof cloneForm.value,
      ClonedVoice
    >('voice-clone:cloneSample', cloneForm.value);
    if (res.ok && res.data) {
      voices.value.push(res.data);
      selectedVoiceId.value = res.data.id;
      showCloneForm.value = false;
      // 重置表单
      cloneForm.value = {
        samplePath: '',
        sampleName: '',
        refText: '',
        language: 'zh',
      };
    }
  } catch (err) {
    synthError.value = err instanceof Error ? err.message : String(err);
  } finally {
    cloning.value = false;
  }
}

/**
 * 删除音色
 * @param voiceId 音色 ID
 */
async function handleDeleteVoice(voiceId: string): Promise<void> {
  try {
    const res = await getApi().invoke<{ voiceId: string }, { deleted: string }>(
      'voice-clone:deleteVoice',
      { voiceId },
    );
    if (res.ok) {
      voices.value = voices.value.filter((v) => v.id !== voiceId);
      if (selectedVoiceId.value === voiceId) {
        selectedVoiceId.value = voices.value[0]?.id || '';
      }
    }
  } catch (err) {
    synthError.value = err instanceof Error ? err.message : String(err);
  }
}

// ===== 音色试听(016 AC) =====
/** 当前试听中的音色 ID */
const previewVoiceId = ref('');
/** 当前试听音频的 objectURL */
const previewSrc = ref('');
/** 试听加载/播放错误提示 */
const previewError = ref('');
/** 试听音频元素引用 */
const previewAudioEl = ref<HTMLAudioElement | null>(null);

/**
 * 加载音色参考音频并播放(试听)
 * 通过 voice-clone:readRefAudio 读取样本二进制 → createObjectURL → 播放
 * 再次点击同一音色则停止并释放
 * @param voice 目标音色
 */
async function handlePreviewVoice(voice: ClonedVoice): Promise<void> {
  // 已在播放该音色 → 停止
  if (previewVoiceId.value === voice.id && previewSrc.value) {
    previewAudioEl.value?.pause();
    revokePreviewSource();
    return;
  }
  previewError.value = '';
  try {
    const res = await getApi().invoke<
      { voiceId: string },
      { mime: string; data: ArrayBuffer }
    >('voice-clone:readRefAudio', { voiceId: voice.id });
    if (!res.ok || !res.data) {
      previewError.value = res.error ?? '读取音色试听失败';
      return;
    }
    revokePreviewSource();
    const blob = new Blob([res.data.data], { type: res.data.mime });
    previewSrc.value = URL.createObjectURL(blob);
    previewVoiceId.value = voice.id;
    // 下一帧渲染 audio 后播放
    requestAnimationFrame(() => {
      previewAudioEl.value?.play().catch(() => {
        previewError.value = '试听播放失败,请检查音频格式';
      });
    });
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : String(err);
  }
}

/**
 * 释放当前试听 objectURL(避免内存泄漏)
 */
function revokePreviewSource(): void {
  if (previewSrc.value) {
    URL.revokeObjectURL(previewSrc.value);
    previewSrc.value = '';
  }
}

/**
 * 试听播放结束:重置试听状态并释放资源
 * 由 <audio @ended> 触发
 */
function onPreviewEnded(): void {
  previewVoiceId.value = '';
  revokePreviewSource();
}

/**
 * 组件卸载时停止试听并释放资源
 */
onUnmounted(() => {
  previewAudioEl.value?.pause();
  revokePreviewSource();
});

/**
 * 开始克隆 TTS 合成
 */
async function handleSynthesize(): Promise<void> {
  if (!canSynthesize.value) return;
  synthesizing.value = true;
  synthProgress.value = 0;
  synthError.value = '';
  synthResult.value = null;

  const baseName = synthOutputName.value.trim() || `clone-tts-${Date.now()}`;
  const outputPath = `${synthOutputDir.value}/${baseName}.wav`;
  const srtPath = synthSrtEnabled.value ? `${synthOutputDir.value}/${baseName}.srt` : undefined;

  try {
    const res = await getApi().invoke<
      {
        text: string;
        voiceId: string;
        outputPath: string;
        srtPath?: string;
        rate?: number;
      },
      { taskId: string; result: { audioPath: string; srtPath?: string; durationSec: number; charCount: number } }
    >('voice-clone:synthesize', {
      text: synthText.value,
      voiceId: selectedVoiceId.value,
      outputPath,
      srtPath,
      rate: synthRate.value,
    });

    if (res.ok && res.data) {
      synthProgress.value = 100;
      synthResult.value = {
        audioPath: res.data.result.audioPath,
        srtPath: res.data.result.srtPath,
      };
    }
  } catch (err) {
    synthError.value = err instanceof Error ? err.message : String(err);
  } finally {
    synthesizing.value = false;
  }
}
</script>

<template>
  <div class="voice-clone-view">
    <h2 class="view-title">语音克隆</h2>

    <!-- 服务状态区 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">GPT-SoVITS 服务</h3>
        <div class="service-status">
          <span class="status-dot" :class="statusDotClass" />
          <span class="status-text">{{ statusText }}</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">安装路径</label>
        <input
          v-model="installPath"
          class="form-input"
          placeholder="GPT-SoVITS 根目录(含 api_v2.py)"
        />
      </div>
      <div class="form-row">
        <label class="form-label">端口</label>
        <input
          v-model.number="servicePort"
          type="number"
          min="1024"
          max="65535"
          class="form-input form-input--narrow"
        />
      </div>

      <div class="action-bar">
        <button class="btn" :disabled="serviceLoading" @click="checkService">
          刷新状态
        </button>
        <button
          class="btn btn--primary"
          :disabled="serviceLoading || serviceStatus === 'running' || serviceStatus === 'starting'"
          @click="handleStartService"
        >
          启动服务
        </button>
        <button
          class="btn"
          :disabled="serviceLoading || serviceStatus === 'stopped' || serviceStatus === 'not-installed'"
          @click="handleStopService"
        >
          停止服务
        </button>
      </div>

      <div v-if="serviceStatus === 'not-installed'" class="hint-block hint-block--warning">
        未检测到 GPT-SoVITS 安装。请先本地安装 GPT-SoVITS(Python 3.10+),并填写安装路径。服务未启动时,克隆 TTS 将不可用。
      </div>
      <div v-else-if="serviceStatus === 'stopped'" class="hint-block">
        GPT-SoVITS 已安装但未启动,点击"启动服务"开始使用克隆音色。
      </div>
      <div v-else-if="serviceStatus === 'running'" class="hint-block hint-block--success">
        GPT-SoVITS 服务运行中,可进行克隆音色 TTS 合成。
      </div>
    </section>

    <!-- 音色库管理 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">音色库</h3>
        <button class="btn btn--small" @click="showCloneForm = !showCloneForm">
          {{ showCloneForm ? '取消' : '+ 克隆新音色' }}
        </button>
      </div>

      <!-- 克隆样本表单 -->
      <div v-if="showCloneForm" class="clone-form">
        <div class="form-row">
          <label class="form-label">样本音频</label>
          <div class="form-input-group">
            <input
              v-model="cloneForm.samplePath"
              class="form-input"
              placeholder="请选择 5-30 秒的样本音频"
              readonly
            />
            <button class="btn btn--small" @click="handlePickSample">选择</button>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label">音色名称</label>
          <input
            v-model="cloneForm.sampleName"
            class="form-input form-input--narrow"
            placeholder="为该音色命名"
          />
        </div>
        <div class="form-row">
          <label class="form-label">参考文本</label>
          <textarea
            v-model="cloneForm.refText"
            class="form-textarea"
            placeholder="样本音频对应的文字内容(GPT-SoVITS 用于对齐音色特征)"
            rows="2"
          />
        </div>
        <div class="form-row">
          <label class="form-label">语言</label>
          <select v-model="cloneForm.language" class="form-select">
            <option v-for="opt in languageOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="action-bar">
          <button
            class="btn btn--primary"
            :disabled="cloning || !cloneForm.samplePath || !cloneForm.sampleName || !cloneForm.refText"
            @click="handleCloneSample"
          >
            {{ cloning ? '克隆中...' : '克隆音色' }}
          </button>
        </div>
      </div>

      <!-- 音色列表 -->
      <div v-if="voicesLoading" class="empty-hint">加载音色库...</div>
      <div v-else-if="voices.length === 0" class="empty-hint">
        暂无克隆音色,点击"+ 克隆新音色"上传样本
      </div>
      <div v-else class="voice-list">
        <label
          v-for="voice in voices"
          :key="voice.id"
          class="voice-item"
          :class="{ 'voice-item--active': selectedVoiceId === voice.id, 'voice-item--previewing': previewVoiceId === voice.id }"
        >
          <input
            type="radio"
            :value="voice.id"
            v-model="selectedVoiceId"
          />
          <div class="voice-item__info">
            <div class="voice-item__name">{{ voice.name }}</div>
            <div class="voice-item__meta">
              {{ voice.language }} · {{ voice.refText.slice(0, 20) }}{{ voice.refText.length > 20 ? '...' : '' }}
            </div>
          </div>
          <button class="btn btn--small" @click.prevent="handlePreviewVoice(voice)">
            {{ previewVoiceId === voice.id ? '停止' : '试听' }}
          </button>
          <button class="btn btn--small btn--danger" @click.prevent="handleDeleteVoice(voice.id)">
            删除
          </button>
        </label>
        <!-- 试听播放器(隐藏,由 JS 控制) -->
        <audio
          ref="previewAudioEl"
          :src="previewSrc"
          @ended="onPreviewEnded"
        />
        <div v-if="previewError" class="error-msg">{{ previewError }}</div>
      </div>
    </section>

    <!-- 克隆 TTS 合成 -->
    <section class="form-section">
      <h3 class="section-title">克隆 TTS 合成</h3>

      <div class="form-row">
        <label class="form-label">待合成文本</label>
        <textarea
          v-model="synthText"
          class="form-textarea"
          placeholder="输入待合成文本(支持长文本,内部自动分片)"
          rows="6"
        />
      </div>
      <div class="form-row form-row--inline">
        <span class="form-hint">{{ synthText.length }} 字符</span>
      </div>

      <div class="form-row">
        <label class="form-label">输出目录</label>
        <div class="form-input-group">
          <input
            v-model="synthOutputDir"
            class="form-input"
            placeholder="请选择输出目录"
            readonly
          />
          <button class="btn btn--small" @click="handlePickOutputDir">选择</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">输出文件名</label>
        <input
          v-model="synthOutputName"
          class="form-input form-input--narrow"
          placeholder="留空则自动命名"
        />
      </div>
      <div class="form-row">
        <label class="form-label">语速</label>
        <input
          v-model.number="synthRate"
          type="number"
          min="-100"
          max="100"
          class="form-input form-input--narrow"
        />
        <span class="form-hint">(-100~100,0 为正常语速)</span>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="synthSrtEnabled" type="checkbox" /> 同时生成 SRT 字幕
        </label>
      </div>

      <div class="action-bar">
        <button
          class="btn btn--primary"
          :disabled="!canSynthesize"
          @click="handleSynthesize"
        >
          {{ synthesizing ? '合成中...' : '开始合成' }}
        </button>
      </div>

      <!-- 进度条 -->
      <div v-if="synthesizing || synthProgress > 0 || synthError" class="progress-section">
        <ProgressBar :progress="synthProgress" :status="progressStatus" />
        <div v-if="synthError" class="error-msg">{{ synthError }}</div>
      </div>

      <!-- 结果 -->
      <div v-if="synthResult" class="result-section">
        <div class="result-label">合成完成</div>
        <div class="result-path" :title="synthResult.audioPath">{{ synthResult.audioPath }}</div>
        <div v-if="synthResult.srtPath" class="result-path" :title="synthResult.srtPath">
          {{ synthResult.srtPath }}
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.voice-clone-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 8px;
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

.service-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-tertiary);

  &--running {
    background: var(--color-accent);
    box-shadow: 0 0 6px rgba(99, 102, 241, 0.5);
  }
  &--starting {
    background: var(--color-warning);
  }
  &--error {
    background: var(--color-error);
  }
  &--not-installed {
    background: var(--color-text-disabled);
  }
  &--stopped {
    background: var(--color-text-tertiary);
  }
}

.status-text {
  font-size: 12px;
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

.form-textarea {
  flex: 1;
  min-height: 60px;
  padding: 8px 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: var(--font-family, inherit);
  outline: none;
  resize: vertical;

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

.btn--danger {
  color: var(--color-error);
  border-color: var(--color-error);

  &:hover {
    background: rgba(217, 101, 101, 0.1);
  }
}

.hint-block {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg-sunken);
  border-radius: 4px;
  border-left: 2px solid var(--color-border-strong);

  &--warning {
    border-left-color: var(--color-warning);
  }
  &--success {
    border-left-color: var(--color-accent);
  }
}

.clone-form {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--color-bg-sunken);
  border-radius: 6px;
}

.empty-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  padding: 8px 0;
}

.voice-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
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

  &--previewing {
    border-color: var(--color-success);
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__name {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  &__meta {
    color: var(--color-text-tertiary);
    font-size: 11px;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  input[type="radio"] {
    cursor: pointer;
  }
}

.action-bar {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.progress-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.error-msg {
  font-size: 12px;
  color: var(--color-error);
}

.result-section {
  margin-top: 12px;
  padding: 10px;
  background: var(--color-bg-sunken);
  border-radius: 4px;
  border-left: 2px solid var(--color-accent);
}

.result-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}

.result-path {
  font-size: 12px;
  color: var(--color-text-primary);
  font-family: var(--font-mono, monospace);
  word-break: break-all;
  margin-top: 4px;
}
</style>
