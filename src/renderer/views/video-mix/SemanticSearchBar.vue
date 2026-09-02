<script setup lang="ts">
/**
 * 素材语义搜索条(PRD-v2.1 FR-4)
 * 职责:自然语言搜索 + 后台建库触发 + 索引状态 + 结果展示(文件名/文件夹/相似度)
 */
import { ref, onMounted } from 'vue';

/** 搜索命中(与主进程 ScoredMaterial 对齐) */
interface ScoredMaterial {
  materialId: string;
  path: string;
  folderId: string;
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

const query = ref('');
const hits = ref<ScoredMaterial[]>([]);
const searching = ref(false);
const message = ref('');
const statusText = ref('');

/** 语义查重状态 */
interface DuplicateGroup {
  materialId: string;
  path: string;
  folderId: string;
  duplicates: { materialId: string; path: string }[];
}
const dupeGroups = ref<DuplicateGroup[]>([]);
const dupeLoading = ref(false);

onMounted(async () => {
  const res = await getApi().invoke<undefined, { total: number; indexed: number }>('semantic:status');
  if (res.ok && res.data) {
    statusText.value = `已索引 ${res.data.indexed}/${res.data.total}`;
  }
});

/** 触发后台建库(断点续建,进度见任务中心) */
async function buildIndex(): Promise<void> {
  await getApi().invoke<undefined, { started: boolean }>('semantic:build');
  message.value = '已开始后台建库,进度见任务中心';
}

/** 语义查重:两两余弦 ≥ 0.95 的近重复分组 */
async function scanDupes(): Promise<void> {
  dupeLoading.value = true;
  try {
    const res = await getApi().invoke<{ threshold?: number }, DuplicateGroup[]>('semantic:dupes', {});
    if (res.ok && res.data) {
      dupeGroups.value = res.data;
      message.value = res.data.length ? `发现 ${res.data.length} 组近重复素材` : '未发现近重复素材';
    } else {
      message.value = res.error ?? '查重失败';
    }
  } finally {
    dupeLoading.value = false;
  }
}

/** 移除一组冗余(组代表保留),随后刷新查重结果 */
async function removeGroup(dupes: { materialId: string }[]): Promise<void> {
  const ids = dupes.map((d) => d.materialId);
  await getApi().invoke<{ materialIds: string[] }, { removed: number }>(
    'semantic:removeMany',
    JSON.parse(JSON.stringify({ materialIds: ids })),
  );
  message.value = `已移除 ${ids.length} 条冗余索引`;
  dupeLoading.value = true;
  try {
    const res = await getApi().invoke<{ threshold?: number }, DuplicateGroup[]>('semantic:dupes', {});
    if (res.ok && res.data) dupeGroups.value = res.data;
  } finally {
    dupeLoading.value = false;
  }
}

/** 执行语义搜索 */
async function search(): Promise<void> {
  if (!query.value.trim() || searching.value) return;
  searching.value = true;
  message.value = '';
  try {
    const res = await getApi().invoke<{ text: string; topK: number }, ScoredMaterial[]>(
      'semantic:search',
      JSON.parse(JSON.stringify({ text: query.value, topK: 20 })),
    );
    if (res.ok && res.data) {
      hits.value = res.data;
      if (!res.data.length) message.value = '无匹配结果(索引未建或相似度过低)';
    } else {
      message.value = res.error ?? '搜索失败';
    }
  } finally {
    searching.value = false;
  }
}
</script>

<template>
  <div class="semantic-bar">
    <input
      v-model="query"
      placeholder="语义搜索:如「海边日落空镜」"
      class="q"
      @keyup.enter="search"
    />
    <button class="btn primary" :disabled="searching || !query.trim()" @click="search">搜索</button>
    <button class="btn" @click="buildIndex">重建索引</button>
    <button class="btn" :disabled="dupeLoading" @click="scanDupes">语义查重</button>
    <span v-if="statusText" class="status">{{ statusText }}</span>
    <span v-if="message" class="msg">{{ message }}</span>
    <ul v-if="hits.length" class="hits">
      <li v-for="h in hits" :key="h.materialId">
        <span class="name">{{ h.name }}</span>
        <span class="folder">{{ h.folderId }}</span>
        <span class="score">{{ (h.score * 100).toFixed(0) }}%</span>
      </li>
    </ul>
    <!-- 语义查重结果(PRD-v2.1 FR-5) -->
    <div v-if="dupeGroups.length" class="dupes">
      <div v-for="g in dupeGroups" :key="g.materialId" class="dupe-group">
        <span class="dupe-name">{{ g.path }}</span>
        <span class="dupe-dups">
          冗余:{{ g.duplicates.map((d) => d.path).join('、') }}
        </span>
        <button class="btn" @click="removeGroup(g.duplicates)">移除冗余</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.semantic-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.q { width: 260px; }
.status { color: #888; font-size: 12px; }
.msg { color: #d9534f; font-size: 13px; }
.hits { list-style: none; padding: 0; margin: 8px 0 0; width: 100%; }
.hits li { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px dashed #eee; font-size: 13px; }
.hits .name { flex: 1; }
.hits .folder { color: #888; }
.hits .score { color: #2e9e5b; }
.dupes { width: 100%; margin-top: 8px; }
.dupe-group { display: flex; gap: 10px; align-items: center; padding: 4px 0; border-bottom: 1px dashed #eee; font-size: 12px; }
.dupe-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dupe-dups { color: #888; }
</style>
