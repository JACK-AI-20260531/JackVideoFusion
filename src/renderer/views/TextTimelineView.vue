<script setup lang="ts">
/**
 * 文本精剪视图(PRD-文本即时间线 v2.0 M2)
 *
 * 职责:选择口播视频 → ASR 句级转写 → 文本面板与预览双向联动
 *       (点句跳画面/删句/一键清理口头禅/压缩停顿/撤销重做)
 *
 * 调用 IPC:
 *   dialog:openFile           - 选择视频文件
 *   text-timeline:prepare     - 创建会话(ASR + 初始 EDL)
 *   text-timeline:applyOps    - 应用编辑操作
 *   text-timeline:cleanup     - 一键清理口头禅
 *   text-timeline:compressPauses - 压缩停顿
 *   text-timeline:undo / redo - 撤销/重做
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TranscriptPanel, { type PanelSegment } from '../components/TranscriptPanel.vue';

// ===== IPC 响应结构 =====
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}
const route = useRoute();
const router = useRouter();

/** 会话快照(text-timeline:* IPC 返回) */
interface TtSnapshot {
  sessionId: string;
  videoPath: string;
  durationSec: number;
  segments: PanelSegment[];
  edl: { clips: { srcStart: number; srcEnd: number; muted?: boolean }[] };
  totalSec: number;
  canUndo: boolean;
  canRedo: boolean;
  proxyPath?: string;
  proxyReady: boolean;
}

// ===== 状态 =====
const videoPath = ref('');
const session = ref<TtSessionSnapshot | null>(null);
const preparing = ref(false);
const prepareError = ref<string | null>(null);
const busy = ref(false);
const lastAction = ref('');
const currentTime = ref(0);
const videoEl = ref<HTMLVideoElement | null>(null);

type TtSessionSnapshot = TtSnapshot;

// 预览地址:代理就绪打 360p 代理(改一次等 5 秒),否则回退原片;导出始终用原画质
const previewSrc = computed(() => {
  const s = session.value;
  if (!s) return '';
  if (s.proxyReady && s.proxyPath) return `file://${s.proxyPath}`;
  return `file://${s.videoPath}`;
});

// 当前播放中的段落 ID(高亮联动)
const activeSegId = computed(() => {
  const s = session.value;
  if (!s) return undefined;
  const t = currentTime.value;
  const hit = s.segments.find((seg) => t >= seg.start && t < seg.end && !seg.deleted);
  return hit?.id;
});

// 已删句数
const deletedCount = computed(() => session.value?.segments.filter((x) => x.deleted).length ?? 0);

/** 选择视频并创建会话 */
async function handlePickVideo(): Promise<void> {
  const res = await getApi().invoke<{ title?: string; filters?: unknown }, string>('dialog:openFile', {
    title: '选择口播视频',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] }],
  });
  if (!res.ok || !res.data) return;
  const picked = Array.isArray(res.data) ? res.data[0] : res.data;
  await prepare(picked);
}

/** 创建会话:ASR 转写 + 初始 EDL */
async function prepare(path: string): Promise<void> {
  videoPath.value = path;
  preparing.value = true;
  prepareError.value = null;
  session.value = null;
  try {
    const res = await getApi().invoke<{ videoPath: string }, TtSessionSnapshot>(
      'text-timeline:prepare',
      { videoPath: path },
    );
    if (res.ok && res.data) {
      session.value = res.data;
      lastAction.value = '';
    } else {
      prepareError.value = res.error ?? '转写失败';
    }
  } catch (err) {
    prepareError.value = err instanceof Error ? err.message : String(err);
  } finally {
    preparing.value = false;
  }
}

/** 点击句子 → 预览 seek(误差 ≤0.3s:直接定位句首) */
function handleSeek(start: number): void {
  if (videoEl.value) {
    videoEl.value.currentTime = start + 0.01;
    void videoEl.value.play().catch(() => {});
  }
}

/** 删除单句 */
async function handleDelete(seg: PanelSegment): Promise<void> {
  await applyOps([{ op: 'cut', start: seg.start, end: seg.end, reason: '删句' }]);
}

/** 应用 ops 的通用封装 */
async function applyOps(ops: unknown[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  busy.value = true;
  try {
    const res = await getApi().invoke<{ sessionId: string; ops: unknown[] }, TtSessionSnapshot>(
      'text-timeline:applyOps',
      { sessionId: s.sessionId, ops },
    );
    if (res.ok && res.data) {
      session.value = res.data;
      lastAction.value = '已应用编辑';
    } else {
      lastAction.value = res.error ?? '操作失败';
    }
  } finally {
    busy.value = false;
  }
}

/** 一键清理口头禅 */
async function handleCleanup(): Promise<void> {
  const s = session.value;
  if (!s) return;
  busy.value = true;
  try {
    const res = await getApi().invoke<{ sessionId: string }, { planned: number }>(
      'text-timeline:cleanup',
      { sessionId: s.sessionId },
    );
    if (res.ok && res.data) {
      await refresh(s.sessionId);
      lastAction.value = `清理口头禅:剪掉 ${res.data.planned} 处`;
    } else {
      lastAction.value = res.error ?? '清理失败';
    }
  } finally {
    busy.value = false;
  }
}

/** 压缩停顿 */
async function handleCompress(): Promise<void> {
  const s = session.value;
  if (!s) return;
  busy.value = true;
  try {
    const res = await getApi().invoke<{ sessionId: string }, { planned: number }>(
      'text-timeline:compressPauses',
      { sessionId: s.sessionId },
    );
    if (res.ok && res.data) {
      await refresh(s.sessionId);
      lastAction.value = `压缩停顿:${res.data.planned} 处`;
    } else {
      lastAction.value = res.error ?? '压缩失败';
    }
  } finally {
    busy.value = false;
  }
}

/** 撤销/重做后刷新快照 */
async function refresh(sessionId: string): Promise<void> {
  const res = await getApi().invoke<{ sessionId: string }, TtSessionSnapshot>(
    'text-timeline:state',
    { sessionId },
  );
  if (res.ok && res.data) {
    session.value = res.data;
  }
}

async function handleUndo(): Promise<void> {
  const s = session.value;
  if (!s) return;
  busy.value = true;
  try {
    const res = await getApi().invoke<{ sessionId: string }, TtSessionSnapshot>(
      'text-timeline:undo',
      { sessionId: s.sessionId },
    );
    if (res.ok && res.data) {
      session.value = res.data;
      lastAction.value = '已撤销';
    }
  } finally {
    busy.value = false;
  }
}

async function handleRedo(): Promise<void> {
  const s = session.value;
  if (!s) return;
  busy.value = true;
  try {
    const res = await getApi().invoke<{ sessionId: string }, TtSessionSnapshot>(
      'text-timeline:redo',
      { sessionId: s.sessionId },
    );
    if (res.ok && res.data) {
      session.value = res.data;
      lastAction.value = '已重做';
    }
  } finally {
    busy.value = false;
  }
}

// ===== 导出 =====
const exporting = ref(false);
const exportProgress = ref(0);
const exportTaskId = ref<string | null>(null);
const exportPaused = ref(false);
const outputDir = ref('');
interface ExportResultView {
  outputPath: string;
  expectedSec: number;
  actualSec: number;
  consistent: boolean;
  clipCount: number;
  mutedClipCount: number;
}
const exportResult = ref<ExportResultView | null>(null);

/** 任务进度推送载荷(与 AIEditView 同构) */
interface TaskProgress {
  taskId: string;
  status: string;
  progress: number;
  output?: string;
  error?: string;
}
let unsubscribeProgress: (() => void) | null = null;

/** 选择输出目录 */
async function handlePickOutputDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择导出目录',
  });
  if (res.ok && res.data) {
    outputDir.value = res.data;
  }
}

/** 订阅任务进度推送,完成后解析导出结果 */
function subscribeProgress(taskId: string): void {
  if (unsubscribeProgress) unsubscribeProgress();
  unsubscribeProgress = getApi().on('task:progress', (...args: unknown[]) => {
    const data = args[0] as TaskProgress;
    if (data && data.taskId === taskId && data.status === 'running') {
      exportProgress.value = data.progress;
    }
  });
}

/** 导出成片(任务队列:进度推送 + 可暂停/取消;渲染层生成 taskId 以便订阅) */
async function handleExport(): Promise<void> {
  const s = session.value;
  if (!s || !outputDir.value) return;
  exporting.value = true;
  exportPaused.value = false;
  exportResult.value = null;
  exportProgress.value = 0;
  const taskId = `ttext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  exportTaskId.value = taskId;
  subscribeProgress(taskId);
  try {
    const res = await getApi().invoke<
      { sessionId: string; outputDir: string; taskId: string },
      ExportResultView | null
    >('text-timeline:export', { sessionId: s.sessionId, outputDir: outputDir.value, taskId });
    if (res.ok && res.data) {
      exportResult.value = res.data;
    } else if (res.ok) {
      // result 为 null:用户暂停
      exportPaused.value = true;
      lastAction.value = '导出已暂停(可继续)';
    } else {
      lastAction.value = res.error ?? '导出失败';
    }
  } finally {
    if (unsubscribeProgress) {
      unsubscribeProgress();
      unsubscribeProgress = null;
    }
    exporting.value = false;
    if (!exportPaused.value) {
      exportTaskId.value = null;
    }
  }
}

/** 暂停导出任务(断点保留) */
async function handleExportPause(): Promise<void> {
  const tid = exportTaskId.value;
  if (!tid) return;
  await getApi().invoke<{ taskId: string }, { paused: string }>(
    'text-timeline:exportPause',
    { taskId: tid },
  );
  // 暂停由 invoke 返回(result=null)时落地,此处仅触发
}

/** 恢复导出任务(从 checkpoint 续渲) */
async function handleExportResume(): Promise<void> {
  const tid = exportTaskId.value;
  if (!tid) return;
  exportPaused.value = false;
  exporting.value = true;
  subscribeProgress(tid);
  try {
    const res = await getApi().invoke<{ taskId: string }, ExportResultView | null>(
      'text-timeline:exportResume',
      { taskId: tid },
    );
    if (res.ok && res.data) {
      exportResult.value = res.data;
    } else if (res.ok) {
      exportPaused.value = true;
      lastAction.value = '导出再次暂停';
    } else {
      lastAction.value = res.error ?? '恢复失败';
    }
  } finally {
    if (unsubscribeProgress) {
      unsubscribeProgress();
      unsubscribeProgress = null;
    }
    exporting.value = false;
    if (!exportPaused.value) {
      exportTaskId.value = null;
    }
  }
}

/** 取消导出任务 */
async function handleExportCancel(): Promise<void> {
  const tid = exportTaskId.value;
  if (!tid) return;
  await getApi().invoke<{ taskId: string }, { cancelled: string }>(
    'text-timeline:exportCancel',
    { taskId: tid },
  );
  exportPaused.value = false;
  lastAction.value = '导出已取消';
}

/** 重置会话并清除跳转参数 */
async function handleReset(): Promise<void> {
  videoPath.value = '';
  session.value = null;
  exportResult.value = null;
  if (typeof route.query.videoPath === 'string') {
    await router.replace({ query: {} });
  }
}

// ===== 对话式改片(PRD FR-4) =====
const instruction = ref('');
const chatBusy = ref(false);
const clarification = ref('');
const pendingPlan = ref<{ planId: string; ops: EditOpView[] } | null>(null);
const planSelected = ref<boolean[]>([]);

/** 计划中的 op(展示用) */
interface EditOpView {
  op: string;
  start?: number;
  end?: number;
  srcStart?: number;
  srcEnd?: number;
  dstIndex?: number;
  reason?: string;
}

/** 秒 → 区间文本(展示用) */
function rangeText(op: EditOpView): string {
  if (op.op === 'cut' || op.op === 'mute') {
    return `${fmt(op.start ?? 0)}-${fmt(op.end ?? 0)}`;
  }
  if (op.op === 'move') {
    return `${fmt(op.srcStart ?? 0)}-${fmt(op.srcEnd ?? 0)} → 位置 ${op.dstIndex ?? 0}`;
  }
  return '';
}

/** 生成编辑计划(指令 → LLM → diff 清单) */
async function handlePlanEdits(): Promise<void> {
  const s = session.value;
  if (!s || instruction.value.trim().length === 0) return;
  chatBusy.value = true;
  clarification.value = '';
  pendingPlan.value = null;
  try {
    const res = await getApi().invoke<{ sessionId: string; instruction: string }, { planId?: string; ops?: EditOpView[]; clarification?: string }>(
      'text-timeline:planEdits',
      { sessionId: s.sessionId, instruction: instruction.value },
    );
    if (!res.ok || !res.data) {
      clarification.value = res.error ?? '生成编辑计划失败';
      return;
    }
    if (res.data.clarification) {
      clarification.value = `🤔 ${res.data.clarification}`;
    } else if (res.data.planId && res.data.ops) {
      pendingPlan.value = { planId: res.data.planId, ops: res.data.ops };
      planSelected.value = res.data.ops.map(() => true);
    }
  } finally {
    chatBusy.value = false;
  }
}

/** 应用勾选的计划 op */
async function handleApplyPlan(): Promise<void> {
  const s = session.value;
  const plan = pendingPlan.value;
  if (!s || !plan) return;
  busy.value = true;
  try {
    const indexes = plan.ops.map((_, i) => i).filter((i) => planSelected.value[i]);
    const res = await getApi().invoke<
      { sessionId: string; planId: string; indexes: number[] },
      TtSessionSnapshot
    >('text-timeline:applyPlan', { sessionId: s.sessionId, planId: plan.planId, indexes });
    if (res.ok && res.data) {
      session.value = res.data;
      lastAction.value = `已应用计划(${indexes.length} 条)`;
      pendingPlan.value = null;
      clarification.value = '';
      instruction.value = '';
    } else {
      lastAction.value = res.error ?? '应用计划失败';
    }
  } finally {
    busy.value = false;
  }
}

/** 播放进度联动:timeupdate → 高亮当前句 */
function onTimeUpdate(): void {
  if (videoEl.value) {
    currentTime.value = videoEl.value.currentTime;
  }
}

/** 秒 → mm:ss */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

onMounted(async () => {
  // 从其它页面(如 AI 切片「精修」按钮)带 videoPath 跳入:自动载入
  const qp = route.query.videoPath;
  if (typeof qp === 'string' && qp.trim().length > 0) {
    videoPath.value = qp;
    await prepare(qp);
  }
});

onUnmounted(() => {
  /* video 元素随组件销毁 */
});
</script>

<template>
  <div class="tt-view">
    <div class="tt-view__header">
      <h2 class="tt-view__title">文本精剪</h2>
      <p class="tt-view__desc">点着字剪视频:点句子跳画面、删句即剪、一键清理口头禅(非破坏性,可撤销)</p>
    </div>

    <!-- 选择视频 -->
    <section v-if="!videoPath" class="tt-pick">
      <button class="btn btn--primary" :disabled="preparing" @click="handlePickVideo">
        {{ preparing ? '正在转写语音…' : '选择口播视频' }}
      </button>
      <div v-if="preparing" class="tt-hint">ASR 转写中,首次需加载/下载 Whisper 模型,请稍候…</div>
      <div v-if="prepareError" class="tt-error">{{ prepareError }}</div>
    </section>

    <template v-else>
      <!-- 预览 + 工具条 -->
      <section class="tt-preview">
        <video
          ref="videoEl"
          class="tt-preview__video"
          :src="previewSrc"
          controls
          @timeupdate="onTimeUpdate"
        />
        <div class="tt-toolbar">
          <button class="btn btn--small" :disabled="busy" @click="handleCleanup">清理口头禅</button>
          <button class="btn btn--small" :disabled="busy" @click="handleCompress">压缩停顿</button>
          <span class="tt-toolbar__sep" />
          <button class="btn btn--small" :disabled="busy || !session?.canUndo" @click="handleUndo">撤销</button>
          <button class="btn btn--small" :disabled="busy || !session?.canRedo" @click="handleRedo">重做</button>
          <button class="btn btn--small" @click="handleReset">换视频</button>
        </div>
        <div class="tt-status">
          <span>原片 {{ session ? fmt(session.durationSec) : '-' }}</span>
          <span>→ 保留 <b>{{ session ? fmt(session.totalSec) : '-' }}</b></span>
          <span v-if="deletedCount > 0">已删 {{ deletedCount }} 句</span>
          <span v-if="session && !session.proxyReady" class="tt-status__proxy">低清代理生成中,当前预览原片…</span>
          <span v-if="lastAction" class="tt-status__action">{{ lastAction }}</span>
        </div>
      </section>

      <!-- 文本面板 -->
      <section class="tt-text">
        <TranscriptPanel
          :segments="session?.segments ?? []"
          :active-id="activeSegId"
          @seek="handleSeek"
          @delete="handleDelete"
        />
      </section>

      <!-- 对话式改片 -->
      <section class="tt-chat">
        <h3 class="tt-chat__title">💬 对话式改片</h3>
        <div class="tt-chat__row">
          <input
            v-model="instruction"
            class="tt-chat__input"
            placeholder="例如:删掉开头的废话 / 把口头禅都清掉 / 第 2 句静音"
            @keyup.enter="handlePlanEdits"
          />
          <button
            class="btn btn--small btn--primary"
            :disabled="chatBusy || instruction.trim().length === 0"
            @click="handlePlanEdits"
          >{{ chatBusy ? '思考中…' : '生成计划' }}</button>
        </div>
        <div v-if="clarification" class="tt-chat__clarify">{{ clarification }}</div>
        <div v-if="pendingPlan" class="tt-chat__plan">
          <div class="tt-chat__plan-title">编辑计划(勾选要应用的项):</div>
          <label v-for="(op, i) in pendingPlan.ops" :key="i" class="tt-chat__op">
            <input v-model="planSelected[i]" type="checkbox" />
            <span :class="op.op === 'cut' ? 'op-cut' : 'op-other'">
              {{ op.op.toUpperCase() }} {{ rangeText(op) }}
            </span>
            <span class="tt-chat__reason">{{ op.reason }}</span>
          </label>
          <button class="btn btn--small btn--primary" :disabled="busy" @click="handleApplyPlan">
            应用选中项
          </button>
        </div>
      </section>

      <!-- 导出 -->
      <section class="tt-export">
        <h3 class="tt-export__title">导出成片</h3>
        <div class="tt-export__row">
          <input class="tt-export__dir" :value="outputDir" placeholder="请选择导出目录" readonly />
          <button class="btn btn--small" :disabled="exporting" @click="handlePickOutputDir">选择目录</button>
          <button
            class="btn btn--primary btn--small"
            :disabled="exporting || exportPaused || outputDir.length === 0"
            @click="handleExport"
          >{{ exporting ? '导出中…' : '按时间线导出' }}</button>
          <button v-if="exporting" class="btn btn--small" @click="handleExportPause">暂停</button>
          <button v-if="exportPaused" class="btn btn--small" @click="handleExportResume">继续导出</button>
          <button v-if="exporting || exportPaused" class="btn btn--small" @click="handleExportCancel">取消导出</button>
        </div>
        <div v-if="exporting" class="tt-export__progress">
          <div class="tt-export__bar"><div class="tt-export__fill" :style="{ width: exportProgress + '%' }" /></div>
          <span class="tt-export__pct">{{ exportProgress }}%</span>
        </div>
        <div v-if="exportPaused" class="tt-export__warn">导出已暂停,进度已保留,点「继续导出」从断点续渲</div>
        <div v-if="exportResult" class="tt-export__result">
          <div class="tt-export__path" :title="exportResult.outputPath">{{ exportResult.outputPath }}</div>
          <div :class="exportResult.consistent ? 'tt-export__ok' : 'tt-export__warn'">
            {{ exportResult.consistent
              ? `✓ 一致性校验通过:期望 ${fmt(exportResult.expectedSec)} / 实际 ${fmt(exportResult.actualSec)}`
              : `⚠ 一致性偏差:期望 ${fmt(exportResult.expectedSec)} / 实际 ${fmt(exportResult.actualSec)},请检查` }}
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped lang="less">
.tt-view {
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

.tt-pick {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.tt-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.tt-error {
  font-size: 12px;
  color: var(--color-error);
}

.tt-preview {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tt-preview__video,
video {
  width: 100%;
  max-height: 320px;
  background: #000;
  border-radius: 6px;
}

.tt-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tt-status {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--color-text-tertiary);

  b {
    color: var(--color-accent);
  }
}

.tt-status__proxy {
  color: var(--color-warning);
}

.tt-text {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 12px;
}

.tt-export {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0;
  }

  &__row {
    display: flex;
    gap: 8px;
  }

  &__dir {
    flex: 1;
    height: 30px;
    padding: 0 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    color: var(--color-text-primary);
    font-size: 12px;
  }

  &__progress {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__bar {
    flex: 1;
    height: 6px;
    background: var(--color-bg-sunken);
    border-radius: 3px;
    overflow: hidden;
  }

  &__fill {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.3s;
  }

  &__pct {
    font-size: 11px;
    color: var(--color-text-tertiary);
    min-width: 32px;
  }

  &__path {
    font-size: 12px;
    color: var(--color-success);
    font-family: monospace;
    word-break: break-all;
  }

  &__ok {
    font-size: 12px;
    color: var(--color-success);
    margin-top: 4px;
  }

  &__warn {
    font-size: 12px;
    color: var(--color-warning);
    margin-top: 4px;
  }
}

.tt-chat {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0;
  }

  &__row {
    display: flex;
    gap: 8px;
  }

  &__input {
    flex: 1;
    height: 30px;
    padding: 0 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    color: var(--color-text-primary);
    font-size: 12px;
  }

  &__clarify {
    font-size: 12px;
    color: var(--color-warning);
    padding: 6px 10px;
    background: rgba(217, 164, 65, 0.08);
    border-radius: 4px;
  }

  &__plan {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__plan-title {
    font-size: 12px;
    color: var(--color-text-tertiary);
  }

  &__op {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    cursor: pointer;
  }

  &__reason {
    color: var(--color-text-tertiary);
  }
}

.op-cut {
  color: var(--color-error);
}

.op-other {
  color: var(--color-accent);
}
</style>
