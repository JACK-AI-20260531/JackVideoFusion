<script setup lang="ts">
/**
 * 矩阵对比视图(PRD-v2.1 FR-6/7)
 * 职责:矩阵分组管理(增删)+ 近 7/30 天播放/互动 SVG 横向条形对比
 *       + 「新作品该发哪组?」匹配建议(可选 LLM 解释)
 * 调用 IPC:matrix-groups:save/list/delete、matrix:compare、matrix:suggest
 */
import { ref, computed, onMounted } from 'vue';

/** 矩阵分组(与主进程 MatrixGroup 对齐) */
interface MatrixGroup {
  id: string;
  name: string;
  platforms: string[];
  createdAt: string;
  updatedAt: string;
}

/** 分组聚合行(与主进程 GroupAggregate 对齐) */
interface GroupAggregate {
  groupId: string;
  name: string;
  totalPlays: number;
  totalEngagement: number;
  published: number;
  engagementRate?: number;
}

/** 分组建议(与主进程 GroupSuggestion 对齐) */
interface GroupSuggestion {
  groupId: string;
  name: string;
  score: number;
}

interface IpcResp<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function getApi() {
  return (
    window as unknown as {
      api: { invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>> };
    }
  ).api;
}

/** 平台中文名 */
const PLATFORM_NAMES: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  shipinhao: '视频号',
  spzx: 'SPZX',
};

const groups = ref<MatrixGroup[]>([]);
const aggregates = ref<GroupAggregate[]>([]);
const message = ref('');

/** 对比窗口与指标 */
const days = ref<7 | 30>(7);
const metric = ref<'plays' | 'engagement'>('plays');

/** 新建分组表单 */
const newName = ref('');
const selectedPlatforms = ref<string[]>([]);

/** 建议面板 */
const suggestTitle = ref('');
const suggestions = ref<GroupSuggestion[]>([]);

/** 条形数据(按当前指标归一化) */
const bars = computed(() => {
  const max = Math.max(
    ...aggregates.value.map((a) => (metric.value === 'plays' ? a.totalPlays : a.totalEngagement)),
    1,
  );
  return aggregates.value.map((a) => {
    const value = metric.value === 'plays' ? a.totalPlays : a.totalEngagement;
    return { name: a.name, value, ratio: value / max };
  });
});

/** 刷新分组列表 */
async function refresh(): Promise<void> {
  const res = await getApi().invoke<undefined, MatrixGroup[]>('matrix-groups:list');
  if (res.ok && res.data) groups.value = res.data;
}

/** 加载聚合数据 */
async function loadAggregates(): Promise<void> {
  const res = await getApi().invoke<{ days: number }, { groups: GroupAggregate[] }>(
    'matrix:compare',
    { days: days.value },
  );
  if (res.ok && res.data) aggregates.value = res.data.groups;
}

onMounted(async () => {
  await refresh();
  await loadAggregates();
});

/** 切换天数窗口 */
async function setDays(d: 7 | 30): Promise<void> {
  days.value = d;
  await loadAggregates();
}

/** 添加分组 */
async function saveGroup(): Promise<void> {
  if (!newName.value.trim() || selectedPlatforms.value.length === 0) {
    message.value = '请填写名称并至少勾选一个平台';
    return;
  }
  const res = await getApi().invoke<{ name: string; platforms: string[] }, MatrixGroup>(
    'matrix-groups:save',
    JSON.parse(JSON.stringify({ name: newName.value.trim(), platforms: selectedPlatforms.value })),
  );
  if (!res.ok) {
    message.value = res.error ?? '保存失败';
    return;
  }
  message.value = '';
  newName.value = '';
  selectedPlatforms.value = [];
  await refresh();
  await loadAggregates();
}

/** 删除分组 */
async function removeGroup(g: MatrixGroup): Promise<void> {
  await getApi().invoke<{ name: string }, boolean>('matrix-groups:delete', { name: g.name });
  await refresh();
  await loadAggregates();
}

/** 匹配建议(含可选 LLM 解释,失败自动降级) */
async function suggest(): Promise<void> {
  if (!suggestTitle.value.trim()) return;
  const res = await getApi().invoke<{ title: string; topN: number; explain: boolean }, { suggestions: GroupSuggestion[]; explanation?: string }>(
    'matrix:suggest',
    JSON.parse(JSON.stringify({ title: suggestTitle.value, topN: 3, explain: true })),
  );
  if (res.ok && res.data) {
    suggestions.value = res.data.suggestions;
    if (res.data.explanation) message.value = `💡 ${res.data.explanation}`;
  } else {
    message.value = res.error ?? '建议失败';
  }
}
</script>

<template>
  <div class="matrix-view">
    <h3 class="section-title">矩阵对比</h3>

    <!-- 窗口与指标切换 -->
    <div class="toolbar">
      <button :class="{ active: days === 7 }" @click="setDays(7)">近 7 天</button>
      <button :class="{ active: days === 30 }" @click="setDays(30)">近 30 天</button>
      <span class="sep">|</span>
      <button :class="{ active: metric === 'plays' }" @click="metric = 'plays'">播放</button>
      <button :class="{ active: metric === 'engagement' }" @click="metric = 'engagement'">互动</button>
    </div>

    <!-- SVG 横向条形图 -->
    <svg class="chart" :height="Math.max(bars.length, 1) * 36 + 8" width="100%">
      <g v-for="(b, i) in bars" :key="b.name" :transform="`translate(0,${i * 36})`">
        <text x="0" y="24" class="bar-label">{{ b.name }}</text>
        <rect x="110" y="10" :width="Math.max(b.ratio * 400, 2)" height="22" rx="4" class="bar-rect" />
        <text x="114" y="38" class="bar-value">{{ b.value }}</text>
      </g>
      <text v-if="!bars.length" x="0" y="20" class="empty">暂无分组,先在下方添加。</text>
    </svg>

    <!-- 分组管理 -->
    <div class="group-form">
      <input v-model="newName" placeholder="分组名称,如「剧情号」" class="gname" />
      <label v-for="(label, key) in PLATFORM_NAMES" :key="key" class="cb">
        <input v-model="selectedPlatforms" type="checkbox" :value="key" />
        {{ label }}
      </label>
      <button class="btn primary" @click="saveGroup">添加分组</button>
      <span v-if="message" class="msg">{{ message }}</span>
    </div>
    <ul class="group-list">
      <li v-for="g in groups" :key="g.id">
        <strong>{{ g.name }}</strong>
        <span class="plat">{{ g.platforms.map((p) => PLATFORM_NAMES[p] ?? p).join('、') }}</span>
        <button class="btn btn--small" @click="removeGroup(g)">删除</button>
      </li>
    </ul>

    <!-- 匹配建议 -->
    <div class="suggest">
      <h4>新作品该发哪组?</h4>
      <input v-model="suggestTitle" placeholder="输入新作品标题" class="q" @keyup.enter="suggest" />
      <button class="btn primary" @click="suggest">推荐分组</button>
      <ol v-if="suggestions.length" class="sug-list">
        <li v-for="s in suggestions" :key="s.groupId">
          {{ s.name }}(匹配 {{ (s.score * 100).toFixed(0) }} 分)
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.matrix-view { padding: 8px 0; }
.toolbar { display: flex; gap: 6px; margin: 8px 0; align-items: center; }
.toolbar .active { color: #2563eb; border-bottom: 2px solid #2563eb; }
.toolbar .sep { color: #666; }
.chart { margin: 8px 0; }
.bar-label, .bar-value { font-size: 12px; fill: #ccc; }
.bar-rect { fill: #2563eb; opacity: 0.85; }
.empty { font-size: 12px; fill: #888; }
.group-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.cb { margin-right: 4px; font-size: 13px; }
.msg { color: #d9534f; font-size: 13px; }
.group-list { list-style: none; padding: 0; margin: 8px 0; }
.group-list li { display: flex; gap: 12px; align-items: center; padding: 6px 0; border-bottom: 1px dashed #333; }
.plat { color: #888; font-size: 12px; flex: 1; }
.suggest h4 { margin: 12px 0 6px; }
.q { width: 280px; }
.sug-list { margin: 8px 0 0; font-size: 13px; }
.btn.primary { background: #2563eb; color: #fff; }
</style>
