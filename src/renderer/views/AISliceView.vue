<script setup lang="ts">
/**
 * AI 切片剪辑视图
 *
 * 职责:长视频 → 镜头检测 → AI 精彩度评估 → 自动切片拆分为多条独立短视频
 *
 * 调用 IPC:
 *   ai-slice:start        - 启动 AI 切片任务
 *   ai-slice:cancel       - 取消任务
 *   dialog:openFile       - 选择视频文件
 *   dialog:openDirectory  - 选择输出目录
 *   common:listResolutions - 加载分辨率列表
 *   task:progress         - 订阅任务进度推送
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore } from '../stores/config';
import ProgressBar from './material-process/ProgressBar.vue';
import WatermarkEditor from '../components/WatermarkEditor.vue';
import {
  copyManifestPaths,
  createManifestFilename,
  downloadManifest,
} from '../utils/export-manifest';
import type {
  ResolutionPreset,
  ResolutionInfo,
  WatermarkConfig,
  WatermarkPosition,
  TaskStatus,
} from '@shared/types';

// 配置仓库(用于加载默认值)
const configStore = useConfigStore();

// ===== 表单参数 =====
// 输入长视频路径
const videoPath = ref('');
// 最小片段时长(秒)
const minClipDuration = ref(8);
// 最大片段时长(秒)
const maxClipDuration = ref(30);
// 精彩度阈值(0-1)
const excitementThreshold = ref(0.5);
// 输出片段数量(0=不限)
const maxClipCount = ref(0);
// 分辨率预设
const resolution = ref<ResolutionPreset>('1080p');
// 是否保留原画质
const keepOriginalQuality = ref(true);
// 输出目录
const outputDir = ref('');
// 输出文件名前缀
const outputPrefix = ref('clip');

// 水印配置
const watermarkConfig = ref<WatermarkConfig>({
  enabled: false,
  type: 'text',
  content: '',
  position: 'bottom-right' as WatermarkPosition,
  opacity: 80,
  marginX: 20,
  marginY: 20,
  fontSize: 24,
  fontColor: 'white',
});

// 分辨率列表(从主进程获取)
const resolutions = ref<ResolutionInfo[]>([]);

// ===== 任务执行状态 =====
// 切片结果列表
const clips = ref<SliceClip[]>([]);
// 是否运行中
const running = ref(false);
// 进度百分比
const progress = ref(0);
// 错误信息
const error = ref<string | null>(null);
// 当前任务 ID
const currentTaskId = ref<string | null>(null);
// 是否已暂停
const paused = ref(false);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'paused' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (paused.value) return 'paused';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(视频路径非空 + 未运行)
const canStart = computed(
  () => videoPath.value.trim().length > 0 && !running.value,
);

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

// 任务进度推送载荷
interface TaskProgress {
  taskId: string;
  status: TaskStatus;
  progress: number;
  output?: string;
  error?: string;
}

// 单个切片结果(与主进程 SliceClip 结构一致)
interface SliceClip {
  index: number;
  outputPath: string;
  startTime: number;
  endTime: number;
  duration: number;
  excitementScore: number;
  virality?: ViralityReport;
}

// 爆款评分报告(与主进程 ViralityReport 结构一致)
interface ViralityReport {
  score: number;
  grade: 'S' | 'A' | 'B' | 'C';
  reasons: string[];
  suggestions: string[];
  titles: string[];
  tags: string[];
  coverText: string[];
  source: 'llm' | 'heuristic';
}

// ai-slice:start IPC 返回结构
interface AiSliceStartResp {
  taskId: string;
  result: {
    clips: SliceClip[];
    totalClips: number;
  };
}

// ai-slice:scoreVirality IPC 返回结构
interface ViralityScoreResp {
  reports: Record<number, ViralityReport>;
  source: 'llm' | 'heuristic';
}

// 进度订阅取消函数
let unsubscribe: (() => void) | null = null;

// ===== 爆款评分状态 =====
// 智能评分进行中
const scoring = ref(false);
// 评分错误信息
const scoreError = ref<string | null>(null);
// 是否按爆款分排序(否则按时间线)
const sortByVirality = ref(false);
// 当前展开详情的切片索引(null=全部收起)
const expandedIndex = ref<number | null>(null);

// 展示用切片列表(排序开关生效)
const clipsView = computed<SliceClip[]>(() => {
  const list = [...clips.value];
  if (sortByVirality.value) {
    list.sort((a, b) => {
      const sa = a.virality?.score ?? -1;
      const sb = b.virality?.score ?? -1;
      return sb - sa;
    });
  }
  return list;
});

/**
 * 等级徽章样式类
 * @param grade 等级
 */
function gradeClass(grade: 'S' | 'A' | 'B' | 'C'): string {
  return `grade--${grade.toLowerCase()}`;
}

/**
 * 展开或收起某条切片的评分详情
 * @param index 切片索引
 */
function toggleExpand(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

/**
 * 复制文本到剪贴板
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板不可用时忽略
  }
}

/**
 * 执行智能评分(爆款评分)
 * 调用 ai-slice:scoreVirality,把返回的评分报告合并进切片列表
 */
async function handleScoreVirality(): Promise<void> {
  if (scoring.value || clips.value.length === 0) return;
  scoring.value = true;
  scoreError.value = null;
  try {
    const payload = clips.value.map((clip) => ({
      index: clip.index,
      outputPath: clip.outputPath,
      duration: clip.duration,
      excitementScore: clip.excitementScore,
    }));
    const res = await getApi().invoke<typeof payload, ViralityScoreResp>(
      'ai-slice:scoreVirality',
      payload,
    );
    if (res.ok && res.data) {
      const reports = res.data.reports;
      clips.value = clips.value.map(
        (clip) => ({ ...clip, virality: reports[clip.index] ?? clip.virality }) as SliceClip,
      );
      // 评分完成后默认按爆款分排序,便于先发高分片段
      sortByVirality.value = true;
    } else {
      scoreError.value = res.error ?? '智能评分失败';
    }
  } catch (err) {
    scoreError.value = err instanceof Error ? err.message : String(err);
  } finally {
    scoring.value = false;
  }
}

/**
 * 组件挂载时加载分辨率列表与配置默认值
 */
onMounted(async () => {
  // IPC 调用做错误兜底:主进程未就绪或调用失败时静默降级
  try {
    await configStore.load();
    const res = await getApi().invoke<unknown, ResolutionInfo[]>('common:listResolutions');
    if (res.ok && res.data) {
      resolutions.value = res.data;
    }
    // 用配置中的默认值初始化表单
    if (configStore.config.defaultExportDir) {
      outputDir.value = configStore.config.defaultExportDir;
    }
    resolution.value = configStore.config.defaultResolution;
    keepOriginalQuality.value = configStore.config.keepOriginalQuality;
  } catch {
    // 降级:保持默认值,不阻断渲染
  }
});

/**
 * 组件卸载时取消进度订阅
 */
onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

/**
 * 选择输入视频文件
 */
async function handlePickVideo(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFile', {
    title: '选择视频文件',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.ok && res.data && res.data.length > 0) {
    videoPath.value = res.data[0];
  }
}

/**
 * 选择输出目录
 */
async function handlePickOutputDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择输出目录',
  });
  if (res.ok && res.data) {
    outputDir.value = res.data;
  }
}

/**
 * 格式化时间为 mm:ss.s
 * @param sec 秒数
 * @returns 格式化后的时间字符串
 */
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
}

/**
 * 订阅任务进度推送(启动/恢复时复用)
 * 更新进度条与 running/paused 状态
 */
function subscribeProgress(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
    const data = args[0] as TaskProgress;
    if (data && currentTaskId.value && data.taskId === currentTaskId.value) {
      progress.value = data.progress;
      if (data.status === 'paused') {
        paused.value = true;
        running.value = false;
      } else if (
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled'
      ) {
        paused.value = false;
        running.value = false;
        if (data.status === 'failed' && data.error) {
          error.value = data.error;
        }
      }
    }
  });
}

/**
 * 开始 AI 切片
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  clips.value = [];
  error.value = null;
  running.value = true;
  paused.value = false;
  progress.value = 0;
  currentTaskId.value = null;

  subscribeProgress();

  try {
    // 构造 AI 切片参数
    const params = {
      videoPath: videoPath.value,
      resolution: resolution.value,
      keepOriginalQuality: keepOriginalQuality.value,
      minClipDuration: minClipDuration.value,
      maxClipDuration: maxClipDuration.value,
      excitementThreshold: excitementThreshold.value,
      maxClipCount: maxClipCount.value,
      watermark: watermarkConfig.value.enabled ? watermarkConfig.value : null,
      outputDir: outputDir.value,
      outputPrefix: outputPrefix.value,
    };

    const res = await getApi().invoke<typeof params, AiSliceStartResp>('ai-slice:start', params);
    if (res.ok && res.data) {
      currentTaskId.value = res.data.taskId;
      clips.value = res.data.result.clips;
      progress.value = 100;
      running.value = false;
    } else {
      error.value = res.error ?? 'AI 切片失败';
      running.value = false;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    running.value = false;
  } finally {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }
}

/**
 * 取消当前 AI 切片任务
 */
async function handleCancel(): Promise<void> {
  if (!currentTaskId.value) return;
  await getApi().invoke<{ taskId: string }, { cancelled: string }>('ai-slice:cancel', {
    taskId: currentTaskId.value,
  });
  running.value = false;
  paused.value = false;
  currentTaskId.value = null;
}

/**
 * 暂停当前 AI 切片任务(保留断点,可继续导出)
 */
async function handlePause(): Promise<void> {
  if (!currentTaskId.value) return;
  await getApi().invoke<{ taskId: string }, { paused: string }>('ai-slice:pause', {
    taskId: currentTaskId.value,
  });
  paused.value = true;
  running.value = false;
}

/**
 * 恢复已暂停的 AI 切片任务(跳过错已导出切片)
 */
async function handleResume(): Promise<void> {
  if (!currentTaskId.value) return;
  running.value = true;
  paused.value = false;
  subscribeProgress();
  await getApi().invoke<{ taskId: string }, { taskId: string; result: unknown }>(
    'ai-slice:resume',
    { taskId: currentTaskId.value },
  );
}

/**
 * 复制全部切片产物路径
 */
async function handleCopyAllClipPaths(): Promise<void> {
  await copyManifestPaths(clips.value.map((clip) => clip.outputPath));
}

/**
 * 导出切片产物路径清单 TXT
 */
function handleExportClipManifest(): void {
  downloadManifest(
    clips.value.map((clip) => clip.outputPath),
    createManifestFilename('ai-slice'),
  );
}
const router = useRouter();

/**
 * 跳转文本精剪页精修该条切片(PRD-v2.0 §6.3)
 * @param outputPath 切片输出路径
 */
function goRefine(outputPath: string): void {
  void router.push({ path: '/text-timeline', query: { videoPath: outputPath } });
}

</script>

<template>
  <div class="ai-slice-view">
    <!-- 页面标题 -->
    <div class="ai-slice-view__header">
      <h2 class="ai-slice-view__title">AI 切片剪辑</h2>
      <p class="ai-slice-view__desc">批量导入长视频,AI 自动识别精彩片段、镜头卡点,自动切片拆分多条独立短视频</p>
    </div>

    <!-- 视频文件选择 -->
    <section class="form-section">
      <h3 class="section-title">输入视频</h3>
      <div class="form-row">
        <label class="form-label">视频文件</label>
        <div class="form-input-group">
          <input v-model="videoPath" class="form-input" placeholder="请选择长视频文件" readonly />
          <button class="btn btn--small" @click="handlePickVideo">选择</button>
        </div>
      </div>
    </section>

    <!-- 切片参数 -->
    <section class="form-section">
      <h3 class="section-title">切片参数</h3>
      <div class="form-row">
        <label class="form-label">最小片段时长(秒)</label>
        <input
          v-model.number="minClipDuration"
          type="number"
          min="1"
          step="1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">最大片段时长(秒)</label>
        <input
          v-model.number="maxClipDuration"
          type="number"
          min="1"
          step="1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">精彩度阈值(0-1)</label>
        <input
          v-model.number="excitementThreshold"
          type="number"
          min="0"
          max="1"
          step="0.1"
          class="form-input form-input--narrow"
        />
      </div>
      <div class="form-row">
        <label class="form-label">输出片段数量</label>
        <input
          v-model.number="maxClipCount"
          type="number"
          min="0"
          step="1"
          class="form-input form-input--narrow"
        />
        <span class="form-hint">0 = 不限,输出所有达标片段</span>
      </div>
    </section>

    <!-- 输出设置 -->
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
        <label class="form-label">文件名前缀</label>
        <input v-model="outputPrefix" class="form-input form-input--narrow" placeholder="clip" />
      </div>
    </section>

    <!-- 水印 -->
    <section class="form-section">
      <h3 class="section-title">水印</h3>
      <WatermarkEditor v-model="watermarkConfig" />
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '切片中...' : '开始 AI 切片' }}
      </button>
      <button v-if="!paused" class="btn" :disabled="!running" @click="handlePause">暂停</button>
      <button v-else class="btn" @click="handleResume">继续</button>
      <button class="btn" :disabled="!running && !paused" @click="handleCancel">取消</button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="clips.length > 0" class="result-section">
      <div class="result-section__header">
        <h3 class="section-title">切片完成({{ clips.length }} 个)</h3>
        <div class="result-section__actions">
          <button
            class="btn btn--small"
            :disabled="scoring"
            title="用 LLM 对每条切片评估爆款潜力,并生成标题/标签建议"
            @click="handleScoreVirality"
          >
            {{ scoring ? '评分中...' : '智能评分' }}
          </button>
          <button class="btn btn--small" @click="sortByVirality = !sortByVirality">
            {{ sortByVirality ? '按时间线排序' : '按爆款分排序' }}
          </button>
          <button class="btn btn--small" @click="handleCopyAllClipPaths">复制全部路径</button>
          <button class="btn btn--small" @click="handleExportClipManifest">导出清单</button>
        </div>
      </div>
      <div v-if="scoreError" class="error-msg">{{ scoreError }}</div>
      <div class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th class="result-table__th">#</th>
              <th class="result-table__th">起始</th>
              <th class="result-table__th">结束</th>
              <th class="result-table__th">时长</th>
              <th class="result-table__th">精彩度</th>
              <th class="result-table__th">爆款分</th>
              <th class="result-table__th">文件路径</th>
              <th class="result-table__th">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="clip in clipsView" :key="clip.index">
              <tr class="result-table__row" @click="toggleExpand(clip.index)">
                <td class="result-table__td">{{ clip.index }}</td>
                <td class="result-table__td">{{ formatTime(clip.startTime) }}</td>
                <td class="result-table__td">{{ formatTime(clip.endTime) }}</td>
                <td class="result-table__td">{{ clip.duration.toFixed(1) }}s</td>
                <td class="result-table__td result-table__td--score">
                  {{ (clip.excitementScore * 100).toFixed(0) }}%
                </td>
                <td class="result-table__td">
                  <span
                    v-if="clip.virality"
                    class="grade-badge"
                    :class="gradeClass(clip.virality.grade)"
                    :title="clip.virality.source === 'llm' ? '智能评分' : '基础评分(未配置 LLM 或评分失败)'"
                  >
                    {{ clip.virality.grade }} {{ clip.virality.score }}
                  </span>
                  <span v-else class="grade-badge grade-badge--none">—</span>
                </td>
                <td class="result-table__td result-table__td--path" :title="clip.outputPath">
                  {{ clip.outputPath }}
                </td>
                <td class="result-table__td">
                  <button class="btn btn--small" title="进入文本精剪:删废话/口头禅" @click.stop="goRefine(clip.outputPath)">精修</button>
                </td>
              </tr>
              <!-- 评分详情(点击行展开/收起) -->
              <tr v-if="expandedIndex === clip.index && clip.virality" class="detail-row">
                <td class="detail-row__td" colspan="8">
                  <div class="detail-panel">
                    <div v-if="clip.virality.reasons.length" class="detail-block">
                      <span class="detail-label">评分理由</span>
                      <ul class="detail-list">
                        <li v-for="(r, i) in clip.virality.reasons" :key="`r${i}`">{{ r }}</li>
                      </ul>
                    </div>
                    <div v-if="clip.virality.suggestions.length" class="detail-block">
                      <span class="detail-label">改进建议</span>
                      <ul class="detail-list">
                        <li v-for="(s, i) in clip.virality.suggestions" :key="`s${i}`">{{ s }}</li>
                      </ul>
                    </div>
                    <div v-if="clip.virality.titles.length" class="detail-block">
                      <span class="detail-label">候选标题</span>
                      <div class="detail-chips">
                        <button
                          v-for="(t, i) in clip.virality.titles"
                          :key="`t${i}`"
                          class="chip"
                          title="点击复制"
                          @click.stop="copyText(t)"
                        >
                          {{ t }}
                        </button>
                      </div>
                    </div>
                    <div v-if="clip.virality.tags.length" class="detail-block">
                      <span class="detail-label">话题标签</span>
                      <div class="detail-chips">
                        <button
                          class="chip"
                          title="点击复制全部标签"
                          @click.stop="copyText(clip.virality.tags.join(' '))"
                        >
                          {{ clip.virality.tags.join(' ') }}
                        </button>
                      </div>
                    </div>
                    <div v-if="clip.virality.coverText.length" class="detail-block">
                      <span class="detail-label">封面文案</span>
                      <div class="detail-chips">
                        <button
                          v-for="(c, i) in clip.virality.coverText"
                          :key="`c${i}`"
                          class="chip"
                          title="点击复制"
                          @click.stop="copyText(c)"
                        >
                          {{ c }}
                        </button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
    <section v-else class="empty-section">
      <div class="empty-hint">暂无切片结果,请先选择视频并点击「开始 AI 切片」</div>
    </section>
  </div>
</template>

<style scoped lang="less">
.ai-slice-view {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__header {
    margin-bottom: 4px;
  }

  &__title {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 4px;
  }

  &__desc {
    font-size: 12px;
    color: var(--color-text-tertiary);
    margin: 0;
  }
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  &:last-child {
    margin-bottom: 0;
  }

  &--inline {
    gap: 24px;
  }
}

.form-label {
  width: 140px;
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

  &:focus {
    border-color: var(--color-accent);
  }

  &--narrow {
    max-width: 200px;
  }
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

  &:focus {
    border-color: var(--color-accent);
  }
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

  input {
    cursor: pointer;
  }
}

.btn--small {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
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
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;

    .section-title {
      margin: 0;
    }
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
}

.result-table-wrap {
  overflow-x: auto;
}

.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  &__th {
    text-align: left;
    padding: 8px 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-secondary);
    font-weight: 600;
    white-space: nowrap;
  }

  &__td {
    padding: 8px 10px;
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-primary);
    white-space: nowrap;

    &--score {
      color: var(--color-accent);
      font-weight: 600;
    }

    &--path {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: monospace;
      color: var(--color-success);
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

.grade-badge {
  display: inline-block;
  min-width: 44px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;

  &--none {
    color: var(--color-text-tertiary);
  }
}

.grade--s {
  background: rgba(255, 77, 79, 0.15);
  color: var(--color-error);
}
.grade--a {
  background: rgba(250, 140, 22, 0.15);
  color: var(--color-warning, var(--color-accent));
}
.grade--b {
  background: rgba(22, 119, 255, 0.15);
  color: var(--color-accent);
}
.grade--c {
  background: var(--color-bg-sunken);
  color: var(--color-text-tertiary);
}

.result-table__row {
  cursor: pointer;

  &:hover {
    background: var(--color-bg-sunken);
  }
}

.detail-row__td {
  padding: 0 10px 12px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
}

.detail-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--color-bg-elevated);
  border-radius: 6px;
}

.detail-block {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.detail-label {
  width: 60px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: 22px;
}

.detail-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 22px;
}

.detail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  height: 22px;
  padding: 0 10px;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: 11px;
  cursor: pointer;

  &:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
}
</style>
