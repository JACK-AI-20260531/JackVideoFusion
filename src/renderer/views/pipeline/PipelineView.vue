<script setup lang="ts">
/**
 * 自动流水线视图(PRD-v2.1 FR-2/3)
 * 职责:管线列表 + 步骤编排(增删/上移下移/参数 JSON 编辑)+ 定时设置 + 运行
 * 调用 IPC:pipeline:save/list/delete/run
 * 约定:人工步骤(文本精修)不进链;产物在任务中心查看
 */
import { ref, onMounted } from 'vue';

/** 本地类型(与 main/services/pipeline/types.ts 对齐,避免渲染层引主进程路径) */
interface PipelineStep {
  type: string;
  params: Record<string, unknown>;
}
interface PipelineSchedule {
  kind: 'daily' | 'weekly' | 'once';
  at: string;
  weekday?: number;
}
interface PipelineRunState {
  startedAt: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  stepStatuses: string[];
  error?: string;
}
interface Pipeline {
  id: string;
  name: string;
  steps: PipelineStep[];
  schedule?: PipelineSchedule;
  scheduleEnabled?: boolean;
  lastRunAt?: string;
  lastRun?: PipelineRunState;
  createdAt: string;
  updatedAt: string;
}

interface IpcResp<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function getApi() {
  return (
    window as unknown as {
      api: {
        invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
      };
    }
  ).api;
}

const pipelines = ref<Pipeline[]>([]);
const editing = ref<Pipeline | null>(null);
const message = ref('');

/** 步骤类型中文标签 */
const TYPE_LABELS: Record<string, string> = {
  'material-split': '素材分割',
  'video-mix-random': '随机混剪',
  'auto-publish': '自动发布',
};

/** 刷新管线列表 */
async function refresh(): Promise<void> {
  const res = await getApi().invoke<undefined, Pipeline[]>('pipeline:list');
  if (res.ok && res.data) pipelines.value = res.data;
}

onMounted(() => {
  void refresh();
});

/** 进入编辑(深拷贝) */
function edit(p: Pipeline): void {
  editing.value = JSON.parse(JSON.stringify(p)) as Pipeline;
}

/** 追加步骤(按类型给默认参数) */
function addStep(type: string): void {
  if (!editing.value) return;
  if (type === 'material-split') {
    editing.value.steps.push({ type, params: { files: [], segmentSec: 5, outputDir: '' } });
  } else if (type === 'video-mix-random') {
    editing.value.steps.push({
      type,
      params: {
        params: {
          mode: 'random',
          folderIds: [],
          perFolderCount: 3,
          resolution: '1080p',
          keepOriginalQuality: false,
        },
      },
    });
  } else {
    editing.value.steps.push({
      type: 'auto-publish',
      params: { params: { platform: 'douyin', videoPath: '', title: '' }, usePrevArtifact: true },
    });
  }
}

/** 删除步骤 */
function removeStep(i: number): void {
  editing.value?.steps.splice(i, 1);
}

/** 步骤上移/下移 */
function moveStep(i: number, dir: -1 | 1): void {
  const steps = editing.value?.steps;
  if (!steps) return;
  const j = i + dir;
  if (j < 0 || j >= steps.length) return;
  [steps[i], steps[j]] = [steps[j], steps[i]];
}

/** 步骤参数 JSON 文本(编辑器展示用) */
function paramsJson(step: PipelineStep): string {
  return JSON.stringify(step.params, null, 2);
}

/** 步骤参数 JSON 回写(容错,非法时提示,保存期由主进程校验兜底) */
function onParamsInput(step: PipelineStep, ev: Event): void {
  const target = ev.target as HTMLTextAreaElement;
  try {
    step.params = JSON.parse(target.value) as Record<string, unknown>;
    message.value = '';
  } catch {
    message.value = '步骤参数 JSON 非法(已暂存,保存时校验)';
  }
}

/** 保存(编辑面板 → IPC 校验 + 落库) */
async function save(): Promise<void> {
  if (!editing.value) return;
  const payload = JSON.parse(JSON.stringify(editing.value));
  const res = await getApi().invoke<Partial<Pipeline>, Pipeline>('pipeline:save', payload);
  if (!res.ok) {
    message.value = res.error ?? '保存失败';
    return;
  }
  message.value = '已保存';
  editing.value = null;
  await refresh();
}

/** 运行管线(异步,进度在任务中心) */
async function run(p: Pipeline): Promise<void> {
  const res = await getApi().invoke<{ id: string }, { started: string }>('pipeline:run', {
    id: p.id,
  });
  message.value = res.ok ? `流水线「${p.name}」已开始,进度见任务中心` : (res.error ?? '运行失败');
}

/** 删除管线 */
async function remove(p: Pipeline): Promise<void> {
  await getApi().invoke<{ id: string }, boolean>('pipeline:delete', { id: p.id });
  await refresh();
}

/** 启停定时 */
async function toggleSchedule(p: Pipeline): Promise<void> {
  const next = { ...p, scheduleEnabled: !p.scheduleEnabled };
  const res = await getApi().invoke<Partial<Pipeline>, Pipeline>(
    'pipeline:save',
    JSON.parse(JSON.stringify(next)),
  );
  if (!res.ok) {
    message.value = res.error ?? '更新失败';
    return;
  }
  await refresh();
}
</script>

<template>
  <div class="pipeline-view">
    <header class="head">
      <h2>自动流水线</h2>
      <p class="sub">把「素材分割 → 随机混剪 → 自动发布」串成链:一键执行、失败即停、支持定时。人工步骤(文本精修)不进链,完成后在任务中心取产物。</p>
    </header>
    <p v-if="message" class="msg">{{ message }}</p>

    <!-- 编辑面板 -->
    <section v-if="editing" class="editor">
      <input v-model="editing.name" placeholder="流水线名称" class="name-input" />

      <div v-for="(step, i) in editing.steps" :key="i" class="step-card">
        <div class="step-head">
          <strong>{{ i + 1 }}. {{ TYPE_LABELS[step.type] ?? step.type }}</strong>
          <span class="step-actions">
            <button title="上移" @click="moveStep(i, -1)">↑</button>
            <button title="下移" @click="moveStep(i, 1)">↓</button>
            <button title="删除" @click="removeStep(i)">✕</button>
          </span>
        </div>
        <textarea :value="paramsJson(step)" rows="5" @change="onParamsInput(step, $event)"></textarea>
      </div>

      <div class="step-add">
        <button @click="addStep('material-split')">+ 素材分割</button>
        <button @click="addStep('video-mix-random')">+ 随机混剪</button>
        <button @click="addStep('auto-publish')">+ 自动发布</button>
      </div>

      <!-- 定时设置 -->
      <div class="schedule-row">
        <label>
          <input v-model="editing.scheduleEnabled" type="checkbox" />
          启用定时
        </label>
        <template v-if="editing.schedule">
          <select v-model="editing.schedule.kind">
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="once">一次</option>
          </select>
          <input v-model="editing.schedule.at" placeholder="08:00" class="time-input" />
          <select
            v-if="editing.schedule.kind === 'weekly'"
            v-model.number="editing.schedule.weekday"
          >
            <option v-for="(n, i) in ['周日', '周一', '周二', '周三', '周四', '周五', '周六']" :key="i" :value="i">
              {{ n }}
            </option>
          </select>
          <button @click="editing.schedule = undefined">取消定时</button>
        </template>
        <button v-else @click="editing.schedule = { kind: 'daily', at: '08:00' }">设置定时</button>
      </div>

      <div class="editor-actions">
        <button class="btn primary" @click="save">保存</button>
        <button class="btn" @click="editing = null">取消</button>
      </div>
    </section>

    <!-- 列表 -->
    <section v-else>
      <button
        class="btn primary"
        @click="editing = { id: '', name: '', steps: [], scheduleEnabled: false, createdAt: '', updatedAt: '' }"
      >
        新建流水线
      </button>
      <div v-for="p in pipelines" :key="p.id" class="pipeline-card">
        <div class="card-head">
          <strong>{{ p.name }}</strong>
          <span class="flow">{{ p.steps.map((s) => TYPE_LABELS[s.type] ?? s.type).join(' → ') }}</span>
        </div>
        <div class="card-actions">
          <button class="btn primary" @click="run(p)">运行</button>
          <button @click="edit(p)">编辑</button>
          <button @click="toggleSchedule(p)">{{ p.scheduleEnabled ? '停用定时' : '启用定时' }}</button>
          <span v-if="p.schedule && p.scheduleEnabled" class="schedule">
            🕓 {{ p.schedule.kind === 'weekly' ? `周${p.schedule.weekday}` : p.schedule.kind }} {{ p.schedule.at }}
          </span>
          <span v-if="p.lastRun" class="last-run">最近:{{ p.lastRun.status }}</span>
          <button class="danger" @click="remove(p)">删除</button>
        </div>
      </div>
      <p v-if="!pipelines.length" class="empty">暂无流水线,点击「新建流水线」开始编排。</p>
    </section>
  </div>
</template>

<style scoped>
.pipeline-view { padding: 20px 24px; overflow-y: auto; height: 100%; }
.head h2 { margin: 0 0 4px; }
.sub { margin: 0 0 12px; color: #888; font-size: 13px; }
.msg { color: #2e9e5b; font-size: 13px; }
.pipeline-card, .editor { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.card-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.flow { color: #666; font-size: 12px; }
.card-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.step-card { border: 1px solid #eee; border-radius: 6px; padding: 8px; margin: 8px 0; }
.step-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.step-actions button { margin-left: 4px; }
.step-card textarea { width: 100%; font-family: Consolas, monospace; font-size: 12px; box-sizing: border-box; }
.step-add { display: flex; gap: 8px; margin: 8px 0; }
.schedule-row { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
.time-input { width: 80px; }
.name-input { width: 240px; }
.editor-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn.primary { background: #2563eb; color: #fff; }
.btn.danger, .danger { color: #d9534f; }
.empty { color: #888; font-size: 13px; }
.schedule, .last-run { font-size: 12px; color: #666; }
</style>
