<script setup lang="ts">
/**
 * 文本分割 Tab
 * 职责:按字数切分文本,保留标点,自动分段,批量导出 TXT
 * 调用 IPC:material-process:text-split(后端纯 Node 字符串处理)
 */
import { ref, computed } from 'vue';
import { useMaterialActions } from './useMaterialActions';
import ProgressBar from './ProgressBar.vue';

// 共享动作 composable
const { running, progress, error, runTask } = useMaterialActions();

// ===== 表单参数 =====
// 待分割文本
const text = ref('');
// 单条最大字数
const charLimit = ref(100);
// 保留标点
const keepPunct = ref(true);
// 自动分段(按段落拆分)
const autoParagraph = ref(true);

// ===== 结果 =====
// 分割后的文本片段
const segments = ref<string[]>([]);

// 文本字数统计
const textCount = computed(() => text.value.length);

// 进度条状态
const progressStatus = computed<'idle' | 'running' | 'completed' | 'failed'>(() => {
  if (error.value) return 'failed';
  if (running.value) return 'running';
  if (progress.value >= 100) return 'completed';
  return 'idle';
});

// 是否可开始(文本非空且未执行中)
const canStart = computed(() => text.value.trim().length > 0 && charLimit.value > 0 && !running.value);

// 隐藏的文件输入(用于导入 TXT)
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * 导入 TXT 文件(浏览器原生 FileReader,无需 IPC)
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
    text.value = String(reader.result ?? '');
  };
  reader.readAsText(file, 'UTF-8');
  // 重置 input value 以便重复选择同一文件
  target.value = '';
}

/**
 * 开始分割:调用 material-process:text-split IPC
 */
async function handleStart(): Promise<void> {
  if (!canStart.value) return;
  segments.value = [];

  const res = await runTask<string[]>('text-split', `文本分割: ${textCount.value} 字`, 'material-process:text-split', {
    text: text.value,
    charLimit: charLimit.value,
    keepPunct: keepPunct.value,
    autoParagraph: autoParagraph.value,
  });

  if (res.ok && res.data) {
    segments.value = res.data;
  }
}

/**
 * 导出 TXT:将分割结果合并为单个 TXT 文件下载(浏览器原生 Blob)
 */
function handleExportTxt(): void {
  if (segments.value.length === 0) return;
  // 以分隔线连接所有片段
  const content = segments.value.map((s, i) => `【第 ${i + 1} 段】\n${s}`).join('\n\n---\n\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `text-split-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="text-split-tab">
    <!-- 参数表单 -->
    <section class="form-section">
      <h3 class="form-section__title">参数设置</h3>
      <div class="form-row">
        <label class="form-label">单条字数</label>
        <input v-model.number="charLimit" type="number" min="1" class="form-input form-input--narrow" />
        <span class="form-hint">每条最大字符数</span>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="keepPunct" type="checkbox" /> 保留标点
        </label>
        <label class="form-checkbox">
          <input v-model="autoParagraph" type="checkbox" /> 自动分段
        </label>
      </div>
    </section>

    <!-- 文本输入 -->
    <section class="form-section">
      <div class="form-section__header">
        <h3 class="form-section__title">文本内容</h3>
        <div class="form-section__actions">
          <span class="char-count">{{ textCount }} 字</span>
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
        placeholder="请输入或粘贴待分割的文本..."
      />
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canStart" @click="handleStart">
        {{ running ? '分割中...' : '开始分割' }}
      </button>
      <button class="btn" :disabled="segments.length === 0" @click="handleExportTxt">
        导出 TXT
      </button>
    </div>

    <!-- 进度条 -->
    <div v-if="running || progress > 0 || error" class="progress-section">
      <ProgressBar :progress="progress" :status="progressStatus" />
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <!-- 结果列表 -->
    <section v-if="segments.length > 0" class="result-section">
      <h3 class="result-section__title">分割结果({{ segments.length }} 条)</h3>
      <div class="segment-list">
        <div v-for="(seg, i) in segments" :key="i" class="segment-item">
          <span class="segment-item__index">{{ i + 1 }}</span>
          <span class="segment-item__text">{{ seg }}</span>
          <span class="segment-item__count">{{ seg.length }} 字</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.text-split-tab {
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
  height: 30px;
  padding: 0 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;

  &:focus { border-color: var(--color-accent); }

  &--narrow { max-width: 120px; }
}

.form-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
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

.segment-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.segment-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: var(--color-bg-sunken);
  border-radius: 4px;
  font-size: 12px;

  &__index {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent-soft);
    color: var(--color-accent);
    border-radius: 4px;
    font-size: 11px;
    flex-shrink: 0;
  }

  &__text {
    flex: 1;
    color: var(--color-text-secondary);
    line-height: 1.5;
    word-break: break-all;
  }

  &__count {
    flex-shrink: 0;
    color: var(--color-text-tertiary);
    font-size: 11px;
  }
}
</style>
