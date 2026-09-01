<script setup lang="ts">
/**
 * 左侧导航栏
 * 职责:展示 7 个功能模块入口,选中态高亮
 */
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import TaskPanel from './TaskPanel.vue';

// 路由实例,用于判断当前激活模块
const route = useRoute();

// 导航项定义(与路由表保持一致)
const navItems = [
  { name: 'material-process', title: '素材处理', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { name: 'video-mix', title: '视频混剪', icon: 'M4 4h16v16H4zM8 4v16M16 4v16' },
  { name: 'ai-edit', title: 'AI剪辑', icon: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z' },
  { name: 'ai-slice', title: 'AI切片剪辑', icon: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4z' },
  { name: 'film-dub-clone', title: '影视解说克隆', icon: 'M4 4h16v12H4zM8 20h8M12 16v4' },
  { name: 'voice-clone', title: '语音克隆', icon: 'M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zM19 11a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 006 6.92V21a1 1 0 102 0v-3.08A7 7 0 0019 11z' },
  { name: 'auto-publish', title: '自动发布', icon: 'M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { name: 'hot-topics', title: '热点选题', icon: 'M12 2c1.5 3 4 4 7 4-1 4-3.5 6-7 6s-6-2-7-6c3 0 5.5-1 7-4zM12 12v10M8 22h8' },
  { name: 'settings', title: '系统设置', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' },
];

// 当前激活的导航项 name
const activeName = computed(() => route.name as string);
</script>

<template>
  <aside class="sidebar">
    <!-- 顶部 Logo 区 -->
    <div class="sidebar__brand">
      <div class="sidebar__logo">智</div>
      <div class="sidebar__brand-text">
        <div class="sidebar__brand-title">AI智剪工坊</div>
        <div class="sidebar__brand-version">v1.6.0</div>
      </div>
    </div>

    <!-- 导航列表 -->
    <nav class="sidebar__nav">
      <router-link
        v-for="item in navItems"
        :key="item.name"
        :to="{ name: item.name }"
        class="sidebar__item"
        :class="{ 'sidebar__item--active': activeName === item.name }"
      >
        <svg class="sidebar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path :d="item.icon" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="sidebar__label">{{ item.title }}</span>
      </router-link>
    </nav>

    <!-- 任务列表面板 -->
    <TaskPanel />

    <!-- 底部状态区 -->
    <div class="sidebar__footer">
      <div class="sidebar__status">
        <span class="sidebar__status-dot" />
        <span class="sidebar__status-text">本地模式</span>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="less">
.sidebar {
  display: flex;
  flex-direction: column;
  width: 200px;
  flex-shrink: 0;
  background: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border-subtle);

  &__brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &__logo {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: #fff;
    font-size: 18px;
    font-weight: 600;
    border-radius: 6px;
  }

  &__brand-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  &__brand-version {
    font-size: 11px;
    color: var(--color-text-tertiary);
  }

  &__nav {
    flex: 1;
    padding: 12px 8px;
    overflow-y: auto;
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 12px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    text-decoration: none;
    font-size: 13px;
    margin-bottom: 2px;
    transition: all 0.15s;

    &:hover {
      background: var(--color-bg-hover);
      color: var(--color-text-primary);
    }

    &--active {
      background: var(--color-accent-soft);
      color: var(--color-accent);
      font-weight: 500;
    }
  }

  &__icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  &__footer {
    padding: 12px 16px;
    border-top: 1px solid var(--color-border-subtle);
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-tertiary);
  }

  &__status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
  }
}
</style>
