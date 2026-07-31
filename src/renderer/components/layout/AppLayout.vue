<script setup lang="ts">
/**
 * 应用主布局
 * 结构:左侧固定导航 + 右侧主功能区 + 底部可折叠日志栏
 */
import { ref } from 'vue';
import Sidebar from './Sidebar.vue';
import LogPanel from './LogPanel.vue';

// 日志栏是否展开
const logExpanded = ref(true);
// 日志栏高度(像素,可拖拽调整)
const logHeight = ref(220);

// 切换日志栏折叠
function toggleLog(): void {
  logExpanded.value = !logExpanded.value;
}
</script>

<template>
  <div class="app-layout">
    <!-- 左侧固定导航 -->
    <Sidebar />

    <!-- 右侧主区域 -->
    <div class="app-main">
      <!-- 功能区(路由出口,带加载占位) -->
      <div class="app-content">
        <router-view v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in">
            <Suspense>
              <component :is="Component" />
              <template #fallback>
                <div class="app-loading">
                  <div class="app-loading__spinner" />
                  <span class="app-loading__text">加载中...</span>
                </div>
              </template>
            </Suspense>
          </Transition>
        </router-view>
      </div>

      <!-- 底部日志栏(可折叠) -->
      <div
        class="app-log"
        :class="{ 'app-log--collapsed': !logExpanded }"
        :style="logExpanded ? { height: `${logHeight}px` } : undefined"
      >
        <div class="app-log__header" @click="toggleLog">
          <span class="app-log__title">运行日志</span>
          <span class="app-log__toggle">{{ logExpanded ? '▾' : '▴' }}</span>
        </div>
        <LogPanel v-show="logExpanded" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.app-layout {
  display: flex;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg-base);
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.app-content {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}

.app-log {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-sunken);
  transition: height 0.2s ease;

  &--collapsed {
    height: 32px !important;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 16px;
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid var(--color-border-subtle);

    &:hover { background: var(--color-bg-hover); }
  }

  &__title {
    font-size: 12px;
    color: var(--color-text-tertiary);
    letter-spacing: 0.5px;
  }

  &__toggle {
    font-size: 10px;
    color: var(--color-text-tertiary);
  }
}

// 路由切换淡入淡出动画
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.2s ease;
}
.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}

// 路由加载占位样式
.app-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;

  &__spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--color-border-default);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  &__text {
    font-size: 12px;
    color: var(--color-text-tertiary);
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
