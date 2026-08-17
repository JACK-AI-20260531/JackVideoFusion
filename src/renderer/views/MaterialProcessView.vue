<script setup lang="ts">
/**
 * 素材处理视图
 * 职责:4 个 Tab 切换(素材分割 / 文本分割 / 微软TTS / 字幕提取)
 * 每个 Tab 独立组件,各自管理表单参数、文件选择、进度、结果
 */
import { ref } from 'vue';
import SplitTab from './material-process/SplitTab.vue';
import TextSplitTab from './material-process/TextSplitTab.vue';
import TtsTab from './material-process/TtsTab.vue';
import TtsBatchTab from './material-process/TtsBatchTab.vue';
import SubtitleTab from './material-process/SubtitleTab.vue';

// Tab 定义
interface TabItem {
  key: string;
  label: string;
  desc: string;
}

// 4 个功能 Tab 配置
const tabs: TabItem[] = [
  { key: 'split', label: '素材分割', desc: '按固定时长分割视频' },
  { key: 'text-split', label: '文本分割', desc: '按字数切分文本' },
  { key: 'tts', label: '微软TTS', desc: '文本转语音合成' },
  { key: 'tts-batch', label: 'TTS批量', desc: '多段文本批量合成' },
  { key: 'subtitle', label: '字幕提取', desc: '批量提取视频字幕' },
];

// 当前激活的 Tab
const activeTab = ref('split');
</script>

<template>
  <div class="material-view">
    <!-- 页面标题 -->
    <div class="material-view__header">
      <h2 class="material-view__title">素材处理</h2>
      <p class="material-view__desc">短视频创作前置素材预处理工具箱</p>
    </div>

    <!-- Tab 导航 -->
    <div class="material-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="material-tabs__item"
        :class="{ 'material-tabs__item--active': activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        <span class="material-tabs__label">{{ tab.label }}</span>
        <span class="material-tabs__desc">{{ tab.desc }}</span>
      </button>
    </div>

    <!-- Tab 内容区 -->
    <div class="material-view__content">
      <SplitTab v-if="activeTab === 'split'" />
      <TextSplitTab v-else-if="activeTab === 'text-split'" />
      <TtsTab v-else-if="activeTab === 'tts'" />
      <TtsBatchTab v-else-if="activeTab === 'tts-batch'" />
      <SubtitleTab v-else-if="activeTab === 'subtitle'" />
    </div>
  </div>
</template>

<style scoped lang="less">
.material-view {
  display: flex;
  flex-direction: column;
  height: 100%;

  &__header {
    margin-bottom: 16px;
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

  &__content {
    flex: 1;
    overflow-y: auto;
    padding-right: 4px;
  }
}

.material-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0;

  &__item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: -1px;

    &:hover {
      background: var(--color-bg-hover);
      border-radius: 4px 4px 0 0;
    }

    &--active {
      border-bottom-color: var(--color-accent);
    }
  }

  &__label {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-secondary);

    .material-tabs__item--active & {
      color: var(--color-accent);
    }
  }

  &__desc {
    font-size: 11px;
    color: var(--color-text-tertiary);
  }
}
</style>
