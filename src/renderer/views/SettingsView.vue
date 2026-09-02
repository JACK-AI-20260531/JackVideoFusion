<script setup lang="ts">
/**
 * 系统设置视图
 * 职责:展示全局配置(分辨率/导出路径/水印/字幕/并发/LLM),
 *       嵌入 WatermarkEditor 与 SubtitleEditor 组件,支持保存与恢复默认
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore } from '../stores/config';
import WatermarkEditor from '../components/WatermarkEditor.vue';
import SubtitleEditor from '../components/SubtitleEditor.vue';

// 配置仓库
const configStore = useConfigStore();
// 路由实例(用于跳转到音色库管理页)
const router = useRouter();

// 音色库摘要(仅在设置页展示音色数量与跳转入口,完整管理走 /voice-clone 页)
const voiceCount = ref(0);
const voiceLibLoading = ref(false);

// CLIP 模型状态
const clipModelReady = ref(false);
const clipRealModel = ref(false);
const clipModelDir = ref('');
const clipModelDirInput = ref('');
const clipDirError = ref('');
const clipDownloading = ref(false);
const clipDownloadPercent = ref(0);
const clipDownloadFile = ref('');
let unsubscribeClipProgress: (() => void) | null = null;

// 自动更新状态
type UpdateState =
  | 'disabled' | 'idle' | 'checking' | 'checking-error' | 'no-update'
  | 'available' | 'downloading' | 'downloaded' | 'error';
const updateState = ref<UpdateState>('idle');
const updatePercent = ref(0);
const updateMessage = ref('');
let unsubscribeUpdateProgress: (() => void) | null = null;

/** 更新状态中文文案 */
const updateStateText = computed(() => {
  switch (updateState.value) {
    case 'disabled': return '开发环境不可用';
    case 'checking': return '检查中...';
    case 'checking-error': return '检查失败';
    case 'no-update': return '已是最新版本';
    case 'available': return '发现新版本';
    case 'downloading': return '下载中';
    case 'downloaded': return '可重启安装';
    case 'error': return '更新出错';
    default: return '未检查';
  }
});

/** 检查/下载按钮文案 */
const updateBtnText = computed(() => {
  if (updateState.value === 'downloading') return '下载中...';
  if (updateState.value === 'available') return '下载更新';
  return '检查更新';
});

/** 是否处于忙碌(禁用按钮) */
const updateBusy = computed(() =>
  updateState.value === 'checking' || updateState.value === 'downloading',
);

/**
 * 订阅更新进度事件(updater:progress)
 */
function subscribeUpdateProgress(): void {
  if (unsubscribeUpdateProgress) {
    unsubscribeUpdateProgress();
    unsubscribeUpdateProgress = null;
  }
  unsubscribeUpdateProgress = getApi().on('updater:progress', (...args: unknown[]) => {
    const data = args[0] as {
      state?: UpdateState;
      percent?: number;
      message?: string;
    } | undefined;
    if (!data) return;
    if (data.state) updateState.value = data.state;
    if (typeof data.percent === 'number') updatePercent.value = data.percent;
    if (data.message) updateMessage.value = data.message;
  });
}

/**
 * 同步初始更新状态并订阅进度
 */
function initUpdate(): void {
  subscribeUpdateProgress();
  getApi().invoke<unknown, { state?: UpdateState; message?: string }>('updater:status')
    .then((res) => {
      if (res.ok && res.data) {
        if (res.data.state) updateState.value = res.data.state;
        if (res.data.message) updateMessage.value = res.data.message;
      }
    })
    .catch(() => {});
}

/**
 * 触发检查更新(发现新版本后自动下拉按钮转变)
 */
async function handleCheckUpdate(): Promise<void> {
  if (updateBusy.value) return;
  updateMessage.value = '';
  // 未打包环境由主进程返回 disabled
  const res = await getApi().invoke<unknown, { state?: UpdateState; message?: string }>('updater:check');
  if (res.ok && res.data) {
    if (res.data.state) updateState.value = res.data.state;
    if (res.data.message) updateMessage.value = res.data.message;
  }
}

/**
 * 下载更新
 */
async function handleDownloadUpdate(): Promise<void> {
  if (updateBusy.value) return;
  const res = await getApi().invoke<unknown, { state?: UpdateState; message?: string }>('updater:download');
  if (res.ok && res.data) {
    if (res.data.state) updateState.value = res.data.state;
    if (res.data.message) updateMessage.value = res.data.message;
  }
}

/**
 * 安装并重启
 */
async function handleInstallUpdate(): Promise<void> {
  await getApi().invoke<unknown, boolean>('updater:install');
}

// ===== 诊断包(PRD-v1.7 FR-8) =====
const diagExporting = ref(false);
const diagMessage = ref('');

/**
 * 导出诊断包(系统信息 + 脱敏配置 + 最近日志)
 */
async function handleExportDiagnostics(): Promise<void> {
  if (diagExporting.value) return;
  diagExporting.value = true;
  diagMessage.value = '';
  try {
    const res = await getApi().invoke<unknown, { path: string }>('diagnostics:export');
    diagMessage.value = res.ok && res.data ? `已导出:${res.data.path}` : res.error ?? '导出失败';
  } finally {
    diagExporting.value = false;
  }
}

/**
 * 查询 CLIP 引擎状态并同步到 UI
 */
async function loadClipStatus(): Promise<void> {
  try {
    interface ClipStatus {
      isRealModel: boolean;
      modelLoaded: boolean;
      modelReady: boolean;
      modelDir: string;
    }
    const res = await getApi().invoke<unknown, ClipStatus>('clip:status');
    if (res.ok && res.data) {
      clipModelReady.value = res.data.modelReady;
      clipRealModel.value = res.data.isRealModel;
      clipModelDir.value = res.data.modelDir;
      clipModelDirInput.value = res.data.modelDir ?? '';
    }
  } catch {
    // 静默降级
  }
}

/**
 * 选择 CN-CLIP 模型目录(调用 dialog:openDirectory IPC)
 */
async function pickClipModelDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, { path: string }>('dialog:openDirectory', {
    title: '选择 CN-CLIP 模型目录',
  });
  if (res.ok && res.data && res.data.path) {
    clipModelDirInput.value = res.data.path;
  }
}

/**
 * 应用新的 CN-CLIP 模型目录
 * 调用 clip:setModelDir 持久化并切换,成功后刷新状态与展示目录
 */
async function applyClipModelDir(): Promise<void> {
  clipDirError.value = '';
  const res = await getApi().invoke<{ dir: string }, { modelDir: string }>('clip:setModelDir', {
    dir: clipModelDirInput.value?.trim() ?? '',
  });
  if (res.ok && res.data) {
    clipModelDir.value = res.data.modelDir ?? '';
    clipModelDirInput.value = res.data.modelDir ?? '';
    // 切换目录后刷新就绪/引擎状态
    await loadClipStatus();
  } else {
    clipDirError.value = `切换模型目录失败: ${res.error ?? '未知错误'}`;
  }
}

/**
 * 订阅模型下载进度(clip:model-progress 事件)
 */
function subscribeClipProgress(): void {
  if (unsubscribeClipProgress) {
    unsubscribeClipProgress();
    unsubscribeClipProgress = null;
  }
  unsubscribeClipProgress = getApi().on('clip:model-progress', (...args: unknown[]) => {
    const data = args[0] as { percent?: number; file?: string } | undefined;
    if (data) {
      clipDownloadPercent.value = data.percent ?? 0;
      clipDownloadFile.value = data.file ?? '';
    }
  });
}

/**
 * 触发 CN-CLIP 模型下载/补齐
 */
async function handleEnsureClipModel(): Promise<void> {
  if (clipDownloading.value) return;
  clipDownloading.value = true;
  clipDownloadPercent.value = 0;
  clipDownloadFile.value = '';
  subscribeClipProgress();
  try {
    const res = await getApi().invoke<unknown, { modelReady: boolean }>('clip:ensureModel');
    if (res.ok && res.data) {
      clipModelReady.value = res.data.modelReady;
      await loadClipStatus();
    }
  } catch {
    // 静默降级
  } finally {
    clipDownloading.value = false;
    if (unsubscribeClipProgress) {
      unsubscribeClipProgress();
      unsubscribeClipProgress = null;
    }
  }
}

// 模板输入项:模板名与可选描述
const templateName = ref('');
const templateDesc = ref('');

/**
 * 保存当前配置为参数模板
 * 模板名不能为空,为空时给出提示并不调用保存
 */
async function handleSaveTemplate(): Promise<void> {
  if (!templateName.value.trim()) {
    configStore.message = '模板名不能为空';
    return;
  }
  const ok = await configStore.saveTemplate(templateName.value.trim(), templateDesc.value.trim() || undefined);
  if (ok) {
    templateName.value = '';
    templateDesc.value = '';
  }
}

/**
 * 删除参数模板(带二次确认)
 * @param name 模板名
 */
async function handleDeleteTemplate(name: string): Promise<void> {
  const confirmed = window.confirm(`确定删除模板「${name}」吗?该操作不可恢复。`);
  if (!confirmed) return;
  await configStore.deleteTemplate(name);
}

/**
 * 格式化模板更新时间
 * @param iso ISO 时间字符串
 * @returns 格式化后的年月日时分
 */
function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 选择导出目录(调用 dialog:openDirectory IPC)
 */
async function pickExportDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, { path: string }>('dialog:openDirectory', {
    title: '选择默认导出目录',
  });
  if (res.ok && res.data && res.data.path) {
    configStore.config.defaultExportDir = res.data.path;
  }
}

/**
 * 保存配置
 */
async function handleSave(): Promise<void> {
  await configStore.save();
}

/**
 * 恢复默认配置
 */
async function handleReset(): Promise<void> {
  await configStore.reset();
}

/**
 * 加载音色库摘要(仅取数量,完整列表由 VoiceCloneView 维护)
 * 主进程未就绪或调用失败时静默降级为 0
 */
async function loadVoiceSummary(): Promise<void> {
  voiceLibLoading.value = true;
  try {
    interface VoiceListItem { id: string; name: string; }
    const res = await getApi().invoke<unknown, VoiceListItem[]>('voice-clone:listVoices');
    if (res.ok && Array.isArray(res.data)) {
      voiceCount.value = res.data.length;
    }
  } catch {
    // 静默降级:不阻塞设置页渲染
    voiceCount.value = 0;
  } finally {
    voiceLibLoading.value = false;
  }
}

/**
 * 跳转到语音克隆页进行音色库完整管理
 */
function goToVoiceLibrary(): void {
  router.push('/voice-clone');
}

// 挂载时加载配置与模板列表
onMounted(() => {
  // IPC 调用兜底:主进程未就绪时不抛未处理 rejection
  configStore.load().catch(() => {});
  configStore.listTemplates().catch(() => {});
  loadVoiceSummary().catch(() => {});
  loadClipStatus().catch(() => {});
  initUpdate();
});

// 销毁前退订模型下载进度与更新进度
onBeforeUnmount(() => {
  if (unsubscribeClipProgress) {
    unsubscribeClipProgress();
    unsubscribeClipProgress = null;
  }
  if (unsubscribeUpdateProgress) {
    unsubscribeUpdateProgress();
    unsubscribeUpdateProgress = null;
  }
});
</script>

<template>
  <div class="settings-view">
    <h2 class="settings-view__title">系统设置</h2>

    <!-- 界面外观(主题) -->
    <section class="settings-section">
      <h3 class="settings-section__title">界面外观</h3>
      <div class="settings-row">
        <label>界面主题</label>
        <div class="settings-radio-group">
          <label class="settings-radio">
            <input v-model="configStore.config.theme" type="radio" value="dark" />
            深色
          </label>
          <label class="settings-radio">
            <input v-model="configStore.config.theme" type="radio" value="light" />
            淡色
          </label>
        </div>
      </div>
      <p class="settings-section__text">切换即时预览;点击「保存设置」后持久化。</p>
    </section>

    <!-- 分辨率与导出设置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">分辨率与导出</h3>
      <div class="settings-row">
        <label>默认分辨率</label>
        <div class="settings-radio-group">
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="720p" />
            720P
          </label>
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="1080p" />
            1080P
          </label>
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="4k" />
            4K
          </label>
        </div>
      </div>
      <div class="settings-row">
        <label>
          <input v-model="configStore.config.keepOriginalQuality" type="checkbox" />
          保留原画质(不强制缩放)
        </label>
      </div>
      <div class="settings-row">
        <label>导出目录</label>
        <input
          v-model="configStore.config.defaultExportDir"
          placeholder="未设置则使用 userData/exports"
        />
        <button class="btn" @click="pickExportDir">选择目录</button>
      </div>
    </section>

    <!-- 水印配置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">水印配置</h3>
      <WatermarkEditor v-model="configStore.config.watermark" />
    </section>

    <!-- 字幕配置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">字幕配置</h3>
      <SubtitleEditor v-model="configStore.config.subtitle" />
    </section>

    <!-- 任务并发 -->
    <section class="settings-section">
      <h3 class="settings-section__title">任务执行</h3>
      <div class="settings-row">
        <label>任务并发数</label>
        <input
          v-model.number="configStore.config.taskConcurrency"
          type="number"
          min="1"
          max="4"
          class="settings-input--narrow"
        />
        <span class="settings-hint">(1-4,建议 1 避免磁盘抢占)</span>
      </div>
    </section>

    <!-- 音色库管理入口(016 AC6) -->
    <section class="settings-section">
      <h3 class="settings-section__title">音色库</h3>
      <div class="settings-row">
        <label>已注册音色</label>
        <span class="settings-voice__count">
          {{ voiceLibLoading ? '加载中...' : `${voiceCount} 个` }}
        </span>
        <button class="btn" @click="goToVoiceLibrary">前往管理</button>
      </div>
      <p class="settings-section__text">
        在「语音克隆」页可注册新音色(上传样本)、试听与删除,GPT-SoVITS 服务状态也由该页管理。
      </p>
    </section>

    <!-- AI 语义识别模型(CN-CLIP) -->
    <section class="settings-section">
      <h3 class="settings-section__title">AI 语义识别模型(中英 CLIP)</h3>
      <div class="settings-row">
        <label>引擎状态</label>
        <span class="settings-clip__status">
          {{ clipRealModel ? '真实 ONNX 引擎' : 'Mock(降级,未加载真实模型)' }}
        </span>
      </div>
      <div class="settings-row">
        <label>权重就绪</label>
        <span class="settings-clip__status" :class="{ 'settings-clip__status--ready': clipModelReady }">
          {{ clipModelReady ? '已就绪' : '未就绪' }}
        </span>
        <button
          class="btn"
          :disabled="clipDownloading || clipModelReady"
          @click="handleEnsureClipModel"
        >
          {{ clipDownloading ? '下载中...' : clipModelReady ? '已下载' : '下载模型' }}
        </button>
      </div>
      <div v-if="clipDownloading" class="settings-clip__progress-wrap">
        <div class="settings-clip__progress">
          <div class="settings-clip__progress-bar" :style="{ width: `${clipDownloadPercent}%` }"></div>
        </div>
        <span class="settings-clip__progress-text">
          {{ clipDownloadFile || '准备中' }} {{ clipDownloadPercent }}%
        </span>
      </div>
      <div class="settings-row">
        <label>模型目录</label>
        <input
          v-model="clipModelDirInput"
          placeholder="自定义目录(留空使用默认 userData/models)"
        />
        <button class="btn" @click="pickClipModelDir">选择目录</button>
        <button class="btn btn--primary" @click="applyClipModelDir">应用</button>
      </div>
      <p v-if="clipDirError" class="settings-clip__error">{{ clipDirError }}</p>
      <p v-if="clipModelDir" class="settings-clip__current">当前:{{ clipModelDir }}</p>
      <p class="settings-section__text">
        首次使用需下载 CN-CLIP 双塔 ONNX 模型(约 760MB)与中文词表到本地,下载完成后 AI 语义素材匹配将使用真实模型。可通过上方修改模型下载目录。
      </p>
    </section>

    <!-- LLM 大模型 -->
    <section class="settings-section">
      <h3 class="settings-section__title">LLM 大模型(云端模式可选)</h3>
      <div class="settings-row">
        <label>Provider</label>
        <select v-model="configStore.config.llm.provider">
          <option value="openai">OpenAI</option>
          <option value="qwen">通义千问</option>
          <option value="ollama">Ollama(本地)</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      <div class="settings-row">
        <label>接口地址</label>
        <input v-model="configStore.config.llm.endpoint" placeholder="https://..." />
      </div>
      <div class="settings-row">
        <label>API Key</label>
        <input v-model="configStore.config.llm.apiKey" type="password" placeholder="sk-..." />
      </div>
      <div class="settings-row">
        <label>模型</label>
        <input v-model="configStore.config.llm.model" placeholder="gpt-4o / qwen-max" />
      </div>
    </section>

    <!-- 参数模板 -->
    <section class="settings-section">
      <h3 class="settings-section__title">参数模板</h3>
      <div class="settings-row">
        <label>模板名</label>
        <input v-model="templateName" placeholder="输入模板名称" />
      </div>
      <div class="settings-row">
        <label>描述</label>
        <input v-model="templateDesc" placeholder="可选的模板描述" />
      </div>
      <div class="settings-row">
        <label></label>
        <button class="btn" @click="handleSaveTemplate">保存当前配置为模板</button>
      </div>

      <!-- 操作反馈消息 -->
      <p v-if="configStore.message" class="settings-template__msg">{{ configStore.message }}</p>

      <!-- 模板列表 -->
      <div v-if="configStore.templates.length" class="settings-template">
        <div v-for="t in configStore.templates" :key="t.name" class="settings-template__item">
          <div class="settings-template__info">
            <span class="settings-template__name">{{ t.name }}</span>
            <span v-if="t.description" class="settings-template__desc">{{ t.description }}</span>
            <span class="settings-template__time">更新于 {{ formatUpdatedAt(t.updatedAt) }}</span>
          </div>
          <div class="settings-template__actions">
            <button class="btn" @click="configStore.loadTemplate(t.name)">套用</button>
            <button class="btn btn--danger" @click="handleDeleteTemplate(t.name)">删除</button>
          </div>
        </div>
      </div>
      <p v-else class="settings-section__text">暂无模板</p>
    </section>

    <!-- 关于 -->
    <section class="settings-section settings-section--about">
      <h3 class="settings-section__title">关于</h3>
      <p class="settings-section__text">AI智剪工坊 v2.2.0 · Windows 桌面端 AI 批量视频混剪工具</p>

      <!-- 自动更新 -->
      <div class="settings-row">
        <label>检查更新</label>
        <span class="settings-update__state" :class="{ 'settings-update__state--ok': updateState === 'no-update' || updateState === 'downloaded' }">
          {{ updateStateText }}
        </span>
        <button
          class="btn"
          :disabled="updateBusy || updateState === 'downloaded'"
          @click="updateState === 'available' ? handleDownloadUpdate() : handleCheckUpdate()"
        >
          {{ updateBtnText }}
        </button>
        <button v-if="updateState === 'downloaded'" class="btn btn--primary" @click="handleInstallUpdate">
          重启安装
        </button>
      </div>
      <div v-if="updateState === 'downloading'" class="settings-update__progress-wrap">
        <div class="settings-update__progress">
          <div class="settings-update__progress-bar" :style="{ width: `${updatePercent}%` }"></div>
        </div>
        <span class="settings-update__progress-text">{{ updateMessage }} {{ updatePercent }}%</span>
      </div>
      <p v-else-if="updateMessage" class="settings-section__text">
        {{ updateMessage }}
      </p>

      <!-- 诊断包(PRD-v1.7 FR-8) -->
      <div class="settings-row">
        <label>诊断包</label>
        <button class="btn" :disabled="diagExporting" @click="handleExportDiagnostics">
          {{ diagExporting ? '导出中...' : '导出诊断包' }}
        </button>
        <span v-if="diagMessage" class="settings-section__text">{{ diagMessage }}</span>
      </div>

      <p class="settings-section__disclaimer">
        免责声明:本工具仅为视频剪辑辅助工具,用户需自行保证素材版权合法,禁止用于侵权、搬运、违规内容创作。
        本工具遵循微软 TTS 开源协议,不剥离、不单独售卖语音能力。
      </p>
    </section>

    <!-- 底部操作按钮 -->
    <div class="settings-footer">
      <!-- 操作反馈消息 -->
      <span v-if="configStore.message" class="settings-footer__msg">{{ configStore.message }}</span>
      <div class="settings-footer__actions">
        <button class="btn" @click="handleReset">恢复默认</button>
        <button class="btn btn--primary" @click="handleSave">保存设置</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.settings-view {
  max-width: 720px;

  &__title {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 24px;
  }
}

.settings-section {
  padding: 20px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  margin-bottom: 16px;

  &__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &__text {
    font-size: 13px;
    color: var(--color-text-secondary);
    margin: 0 0 8px;
  }

  &__disclaimer {
    font-size: 12px;
    color: var(--color-text-tertiary);
    line-height: 1.7;
    margin: 0;
  }
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  label {
    width: 100px;
    font-size: 13px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  input, select {
    flex: 1;
    height: 32px;
    padding: 0 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    color: var(--color-text-primary);
    font-size: 13px;
    outline: none;

    &:focus { border-color: var(--color-accent); }
  }
}

.settings-input--narrow {
  width: 80px !important;
  flex: none !important;
}

.settings-radio-group {
  display: flex;
  gap: 16px;
}

.settings-radio {
  display: flex;
  align-items: center;
  gap: 4px;
  width: auto !important;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input { width: auto; flex: none; cursor: pointer; }
}

.settings-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.settings-voice__count {
  flex: 1;
  font-size: 13px;
  color: var(--color-text-primary);
  font-weight: 600;
}

.settings-clip {
  &__status {
    flex: 1;
    font-size: 13px;
    color: var(--color-warning);
    font-weight: 600;
  }

  &__status--ready {
    color: var(--color-success);
  }

  &__error {
    font-size: 13px;
    color: var(--color-error);
    margin: 0 0 12px 112px;
  }

  &__current {
    font-size: 12px;
    color: var(--color-text-tertiary);
    margin: 0 0 8px;
    word-break: break-all;
  }

  &__progress-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 12px 112px;
  }

  &__progress {
    flex: 1;
    height: 8px;
    background: var(--color-bg-sunken);
    border-radius: 4px;
    overflow: hidden;
  }

  &__progress-bar {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.2s;
  }

  &__progress-text {
    width: 140px;
    font-size: 12px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
}

.settings-update {
  &__state {
    flex: 1;
    font-size: 13px;
    color: var(--color-text-secondary);
    font-weight: 600;
  }

  &__state--ok {
    color: var(--color-success);
  }

  &__progress-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 12px 112px;
  }

  &__progress {
    flex: 1;
    height: 8px;
    background: var(--color-bg-sunken);
    border-radius: 4px;
    overflow: hidden;
  }

  &__progress-bar {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.2s;
  }

  &__progress-text {
    width: 140px;
    font-size: 12px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
}

.settings-template {
  &__msg {
    font-size: 13px;
    color: var(--color-accent);
    margin: 0 0 12px;
  }

  .btn--danger {
    background: transparent;
    border-color: var(--color-error);
    color: var(--color-error);

    &:hover {
      background: var(--color-error);
      color: #fff;
    }
  }

  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border-subtle);

    &:last-child { border-bottom: none; }
  }

  &__info {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  &__name {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
    flex-shrink: 0;
  }

  &__desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__time {
    font-size: 12px;
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  &__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;

  &__msg {
    font-size: 13px;
    color: var(--color-success);
  }

  &__actions {
    display: flex;
    gap: 8px;
  }
}
</style>
