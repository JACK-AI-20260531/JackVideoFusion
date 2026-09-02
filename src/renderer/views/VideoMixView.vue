<script setup lang="ts">
/**
 * 视频混剪视图(双模式入口)
 * 职责:Tab 切换「随机素材混剪」与「文件夹音频匹配」
 * 复用 AppLayout 的深色主题样式(使用 CSS 变量 var(--color-*))
 */
import { ref } from 'vue';
import RandomMixTab from './video-mix/RandomMixTab.vue';
import AudioMatchTab from './video-mix/AudioMatchTab.vue';
import SemanticSearchBar from './video-mix/SemanticSearchBar.vue';

// Tab 定义
interface TabItem {
  key: string;
  label: string;
  desc: string;
}

// 两个混剪模式 Tab 配置
const tabs: TabItem[] = [
  { key: 'random', label: '随机素材混剪', desc: '从多文件夹随机抽取片段拼接' },
  { key: 'audio-match', label: '文件夹音频匹配', desc: '每文件夹用其音频配视频合成' },
];

// 当前激活的 Tab
const activeTab = ref('random');
</script>

<template>
  <div class="video-mix-view">
    <!-- 页面标题 -->
    <div class="video-mix-view__header">
      <h2 class="video-mix-view__title">视频混剪</h2>
      <p class="video-mix-view__desc">两大核心混剪模式:随机素材混剪、文件夹音频匹配合成</p>
    </div>

    <!-- 素材语义搜索条(自然语言找素材,PRD-v2.1 FR-4) -->
    <SemanticSearchBar />

    <!-- Tab 导航 -->
    <div class="video-mix-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="video-mix-tabs__item"
        :class="{ 'video-mix-tabs__item--active': activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        <span class="video-mix-tabs__label">{{ tab.label }}</span>
        <span class="video-mix-tabs__desc">{{ tab.desc }}</span>
      </button>
    </div>

    <!-- Tab 内容区 -->
    <div class="video-mix-view__content">
      <RandomMixTab v-if="activeTab === 'random'" />
      <AudioMatchTab v-else-if="activeTab === 'audio-match'" />
    </div>
  </div>
</template>

<style scoped lang="less">
.video-mix-view {
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

.video-mix-tabs {
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

    .video-mix-tabs__item--active & {
      color: var(--color-accent);
    }
  }

  &__desc {
    font-size: 11px;
    color: var(--color-text-tertiary);
  }
}
</style>
