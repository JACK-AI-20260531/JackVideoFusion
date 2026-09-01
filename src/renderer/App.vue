<script setup lang="ts">
/**
 * 根组件
 * 职责:展示启动页免责声明,确认后进入主布局;挂载全局错误捕获
 */
import { ref, onMounted, onErrorCaptured, watch } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import { useConfigStore } from './stores/config';

// 是否已确认免责声明
const accepted = ref(false);
// 全局错误信息(用于在页面底部展示错误提示)
const globalError = ref('');
// 配置仓库(用于界面主题)
const configStore = useConfigStore();

/**
 * 应用界面主题:在 <html> 上设置 data-theme 属性,由 CSS 变量驱动皮肤切换
 * @param theme 'dark' | 'light'
 */
function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

// 挂载全局错误监听:捕获未处理异常,避免应用静默崩溃
onMounted(async () => {
  const saved = localStorage.getItem('jvf:disclaimer-accepted');
  if (saved === 'true') accepted.value = true;

  // 捕获渲染层未处理的 Promise 异常
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Unhandled Rejection]', event.reason);
    globalError.value = event.reason?.message || String(event.reason);
    setTimeout(() => { globalError.value = ''; }, 5000);
  });

  // 捕获渲染层同步异常
  window.addEventListener('error', (event) => {
    console.error('[Global Error]', event.error || event.message);
    globalError.value = event.message || '未知错误';
    setTimeout(() => { globalError.value = ''; }, 5000);
  });

  // 加载全局配置(含主题),并应用皮肤
  await configStore.load().catch(() => {});
  applyTheme(configStore.config.theme || 'dark');
});

// 监听主题变化,实时切换皮肤
watch(
  () => configStore.config.theme,
  (theme) => {
    if (theme) applyTheme(theme);
  },
);

// Vue 组件级错误捕获:阻止错误向上冒泡导致白屏
onErrorCaptured((err) => {
  console.error('[Component Error]', err);
  globalError.value = err instanceof Error ? err.message : String(err);
  setTimeout(() => { globalError.value = ''; }, 5000);
  return false;
});

// 用户点击"我已阅读并同意"
function handleAccept(): void {
  localStorage.setItem('jvf:disclaimer-accepted', 'true');
  accepted.value = true;
}
</script>

<template>
  <template v-if="accepted">
    <AppLayout />
  </template>
  <template v-else>
    <div class="disclaimer-screen">
      <div class="disclaimer-card">
        <h1 class="disclaimer-title">AI智剪工坊</h1>
        <p class="disclaimer-subtitle">AI 批量视频混剪工具 · v2.0.0</p>
        <div class="disclaimer-body">
          <h3>免责声明</h3>
          <p>本工具仅为视频剪辑辅助工具,用户需自行保证素材版权合法,禁止用于侵权、搬运、违规内容创作。</p>
          <p>本工具遵循微软 TTS 开源协议,不剥离、不单独售卖语音能力。所有素材处理在本地完成,不上传云端。</p>
          <p>使用自动发布功能时,请遵守各平台运营规则,因违规操作产生的后果由用户自行承担。</p>
        </div>
        <button class="disclaimer-btn" @click="handleAccept">我已阅读并同意</button>
      </div>
    </div>
  </template>
  <!-- 全局错误提示条:5秒自动消失 -->
  <Transition name="error-toast">
    <div v-if="globalError" class="error-toast">
      <span class="error-toast__icon">!</span>
      <span class="error-toast__msg">{{ globalError }}</span>
    </div>
  </Transition>
</template>

<style scoped lang="less">
.disclaimer-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg-base);

  .disclaimer-card {
    width: 560px;
    padding: 40px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-subtle);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    text-align: center;
  }

  .disclaimer-title {
    font-size: 28px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 8px;
  }

  .disclaimer-subtitle {
    font-size: 13px;
    color: var(--color-text-tertiary);
    margin: 0 0 32px;
  }

  .disclaimer-body {
    text-align: left;
    padding: 20px;
    background: var(--color-bg-sunken);
    border-radius: 8px;
    margin-bottom: 28px;

    h3 {
      font-size: 14px;
      color: var(--color-text-secondary);
      margin: 0 0 12px;
    }

    p {
      font-size: 13px;
      line-height: 1.7;
      color: var(--color-text-secondary);
      margin: 0 0 10px;

      &:last-child { margin-bottom: 0; }
    }
  }

  .disclaimer-btn {
    width: 100%;
    height: 40px;
    background: var(--color-accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;

    &:hover { background: var(--color-accent-hover); }
  }
}

// 全局错误提示条样式
.error-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--color-error, #d96565);
  color: #fff;
  border-radius: 6px;
  font-size: 13px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 99999;

  &__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 50%;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }

  &__msg {
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// 错误提示条进出动画
.error-toast-enter-active,
.error-toast-leave-active {
  transition: all 0.3s ease;
}
.error-toast-enter-from,
.error-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
</style>
