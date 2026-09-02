<script setup lang="ts">
/**
 * 热点选题视图(PRD-v1.7 FR-6)
 * 职责:聚合热榜 → 结合素材库生成选题建议 → 一键生成口播脚本
 * IPC:
 *   hot-topics:fetch          - 聚合热榜
 *   hot-topics:suggest        - 生成选题建议(LLM)
 *   hot-topics:generateScript - 生成脚本并落盘
 */
import { ref } from 'vue';

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明
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

/** 热榜抓取结果 */
interface TopicsResp {
  topics: string[];
  sources: { source: string; ok: boolean; topics: string[] }[];
}

/** 选题建议 */
interface Suggestion {
  title: string;
  angle: string;
  tags: string[];
}

const topics = ref<string[]>([]);
const sourceSummary = ref('');
const topicsLoading = ref(false);
const suggestions = ref<Suggestion[]>([]);
const suggestLoading = ref(false);
const scriptBusy = ref<Record<string, boolean>>({});
const scriptText = ref('');
const scriptPath = ref('');
const error = ref<string | null>(null);

/**
 * 聚合抓取热榜
 */
async function handleFetchTopics(): Promise<void> {
  if (topicsLoading.value) return;
  topicsLoading.value = true;
  error.value = null;
  try {
    const res = await getApi().invoke<unknown, TopicsResp>('hot-topics:fetch');
    if (res.ok && res.data) {
      topics.value = res.data.topics;
      const okSources = res.data.sources.filter((s) => s.ok).map((s) => s.source);
      sourceSummary.value =
        okSources.length > 0 ? `来源:${okSources.join('/')},共 ${topics.value.length} 条` : '热点服务暂不可用';
      if (topics.value.length === 0) {
        error.value = '热点服务暂不可用,可稍后重试或直接输入选题';
      }
    } else {
      error.value = res.error ?? '热榜抓取失败';
    }
  } finally {
    topicsLoading.value = false;
  }
}

/**
 * 生成选题建议(LLM)
 */
async function handleSuggest(): Promise<void> {
  if (suggestLoading.value) return;
  suggestLoading.value = true;
  error.value = null;
  try {
    const res = await getApi().invoke<{ topics: string[] }, { suggestions: Suggestion[] }>(
      'hot-topics:suggest',
      { topics: topics.value },
    );
    if (res.ok && res.data) {
      suggestions.value = res.data.suggestions;
      if (suggestions.value.length === 0) {
        error.value = '未生成选题建议,请检查 LLM 配置(系统设置)';
      }
    } else {
      error.value = res.error ?? '选题建议生成失败';
    }
  } finally {
    suggestLoading.value = false;
  }
}

/**
 * 为选题生成口播脚本
 * @param suggestion 选题建议
 */
async function handleGenerateScript(suggestion: Suggestion): Promise<void> {
  const key = suggestion.title;
  if (scriptBusy.value[key]) return;
  scriptBusy.value = { ...scriptBusy.value, [key]: true };
  scriptText.value = '';
  scriptPath.value = '';
  try {
    const res = await getApi().invoke<{ topic: string }, { script: string; path: string }>(
      'hot-topics:generateScript',
      { topic: suggestion.title },
    );
    if (res.ok && res.data) {
      scriptText.value = res.data.script;
      scriptPath.value = res.data.path;
    } else {
      error.value = res.error ?? '脚本生成失败';
    }
  } finally {
    scriptBusy.value = { ...scriptBusy.value, [key]: false };
  }
}

/**
 * 复制脚本到剪贴板
 */
async function handleCopyScript(): Promise<void> {
  if (scriptText.value) {
    await navigator.clipboard.writeText(scriptText.value);
  }
}

// ===== 语义推荐素材(PRD-v2.2 FR-6) =====
import { useRouter } from 'vue-router';
import { useMaterialPickStore } from '../stores/materialPick';

/** 语义推荐命中(与主进程 ScoredMaterial 对齐) */
interface SemanticHit {
  materialId: string;
  path: string;
  folderId: string;
  name: string;
  score: number;
  tags: string[];
}

const router = useRouter();
const pickStore = useMaterialPickStore();

/** 推荐中 */
const recommendBusy = ref(false);
/** 推荐提示(失败/为空) */
const recommendMsg = ref('');
/** 推荐命中列表 */
const recommendHits = ref<SemanticHit[]>([]);
/** 已勾选的命中 materialId(默认全选) */
const recommendSelected = ref<Set<string>>(new Set());

/**
 * 用脚本全文做语义搜索,推荐 Top-N 素材
 */
async function handleRecommend(): Promise<void> {
  if (recommendBusy.value || scriptText.value.trim().length === 0) return;
  recommendBusy.value = true;
  recommendMsg.value = '';
  recommendHits.value = [];
  try {
    const res = await getApi().invoke<{ text: string; topK: number }, SemanticHit[]>(
      'semantic:search',
      JSON.parse(JSON.stringify({ text: scriptText.value, topK: 12, threshold: 0.2 })),
    );
    if (res.ok && res.data) {
      recommendHits.value = res.data;
      recommendSelected.value = new Set(res.data.map((h) => h.materialId));
      if (res.data.length === 0) {
        recommendMsg.value = '无匹配素材(索引未建或相似度过低),可先在视频混剪页「重建索引」';
      }
    } else {
      recommendMsg.value = res.error ?? '推荐失败';
    }
  } finally {
    recommendBusy.value = false;
  }
}

/** 勾选/取消一条推荐命中 */
function toggleHit(id: string): void {
  const next = new Set(recommendSelected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  recommendSelected.value = next;
}

/**
 * 一键进混剪:选中素材写入跨页选中区并跳转视频混剪页(素材清单模式)
 */
function sendToMix(): void {
  const paths = recommendHits.value
    .filter((h) => recommendSelected.value.has(h.materialId))
    .map((h) => h.path);
  if (paths.length === 0) return;
  pickStore.set(paths);
  router.push('/video-mix');
}

/** 复制全部命中路径(物料清单) */
async function copyRecommendPaths(): Promise<void> {
  if (recommendHits.value.length > 0) {
    await navigator.clipboard.writeText(recommendHits.value.map((h) => h.path).join('\n'));
  }
}
</script>

<template>
  <div class="hot-topics-view">
    <div class="view-header">
      <h2 class="view-title">热点选题</h2>
      <p class="view-desc">聚合热榜话题,结合素材库生成选题建议与口播脚本</p>
    </div>

    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">热榜</h3>
        <div class="result-section__actions">
          <button class="btn btn--small" :disabled="topicsLoading" @click="handleFetchTopics">
            {{ topicsLoading ? '抓取中...' : '抓取热榜' }}
          </button>
          <button
            class="btn btn--small btn--primary"
            :disabled="suggestLoading"
            @click="handleSuggest"
          >
            {{ suggestLoading ? '生成中...' : '生成选题建议' }}
          </button>
        </div>
      </div>
      <div v-if="sourceSummary" class="source-summary">{{ sourceSummary }}</div>
      <div v-if="topics.length > 0" class="topic-cloud">
        <span v-for="t in topics.slice(0, 30)" :key="t" class="topic-chip">{{ t }}</span>
      </div>
      <div v-else class="empty-hint">点击「抓取热榜」获取最新热点话题</div>
    </section>

    <section v-if="suggestions.length > 0" class="form-section">
      <h3 class="section-title">选题建议</h3>
      <div v-for="s in suggestions" :key="s.title" class="suggestion-item">
        <div class="suggestion-item__head">
          <span class="suggestion-item__title">{{ s.title }}</span>
          <button
            class="btn btn--small"
            :disabled="scriptBusy[s.title]"
            @click="handleGenerateScript(s)"
          >
            {{ scriptBusy[s.title] ? '生成中...' : '生成脚本' }}
          </button>
        </div>
        <div v-if="s.angle" class="suggestion-item__angle">{{ s.angle }}</div>
        <div v-if="s.tags.length > 0" class="suggestion-item__tags">{{ s.tags.join(' ') }}</div>
      </div>
    </section>

    <section v-if="scriptText" class="form-section">
      <div class="section-header">
        <h3 class="section-title">口播脚本</h3>
        <div class="result-section__actions">
          <button class="btn btn--small" @click="handleCopyScript">复制</button>
          <button
            class="btn btn--small btn--primary"
            :disabled="recommendBusy"
            title="用脚本全文语义搜索素材库,推荐 Top-N 素材"
            @click="handleRecommend"
          >
            {{ recommendBusy ? '推荐中...' : '语义推荐素材' }}
          </button>
        </div>
      </div>
      <pre class="script-box">{{ scriptText }}</pre>
      <div v-if="scriptPath" class="form-hint">已保存到:{{ scriptPath }}</div>
    </section>

    <!-- 语义推荐素材面板(PRD-v2.2 FR-6) -->
    <section v-if="recommendHits.length > 0 || recommendMsg" class="form-section">
      <div class="section-header">
        <h3 class="section-title">语义推荐素材({{ recommendSelected.size }}/{{ recommendHits.length }})</h3>
        <div class="result-section__actions">
          <button class="btn btn--small" @click="copyRecommendPaths">复制全部路径</button>
          <button class="btn btn--small btn--primary" @click="sendToMix">一键进混剪</button>
        </div>
      </div>
      <div v-if="recommendMsg" class="form-hint">{{ recommendMsg }}</div>
      <div v-for="h in recommendHits" :key="h.materialId" class="rec-item">
        <label class="rec-item__check">
          <input
            type="checkbox"
            :checked="recommendSelected.has(h.materialId)"
            @change="toggleHit(h.materialId)"
          />
          <span class="rec-item__name">{{ h.name }}</span>
        </label>
        <span class="rec-item__tags">{{ h.tags.join(' / ') }}</span>
        <span class="rec-item__score">{{ (h.score * 100).toFixed(0) }}%</span>
      </div>
      <div class="form-hint">点击「一键进混剪」后,所选素材将以清单模式在视频混剪页直接参与混剪</div>
    </section>

    <div v-if="error" class="error-msg">{{ error }}</div>
  </div>
</template>

<style scoped lang="less">
.hot-topics-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-header {
  margin-bottom: 4px;
}

.view-title {
  margin: 0;
  font-size: 20px;
}

.view-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.source-summary {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.topic-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.topic-chip {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  font-size: 12px;
}

.suggestion-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  margin-bottom: 8px;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__title {
    font-weight: 600;
    font-size: 14px;
  }

  &__angle {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  &__tags {
    font-size: 12px;
    color: var(--color-accent);
  }
}

.script-box {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  font-family: inherit;
}

.rec-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--color-border);
  font-size: 13px;

  &__check {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  &__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__tags {
    color: var(--color-text-secondary);
    font-size: 12px;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__score {
    color: #2e9e5b;
    font-size: 12px;
  }
}
</style>
