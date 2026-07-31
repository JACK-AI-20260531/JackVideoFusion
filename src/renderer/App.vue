<script setup lang="ts">
/**
 * 根组件
 * 职责:展示启动页免责声明,确认后进入主布局
 */
import { ref, onMounted } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';

// 是否已确认免责声明
const accepted = ref(false);

// 持久化用户确认状态,避免每次启动都弹窗
onMounted(() => {
  const saved = localStorage.getItem('jvf:disclaimer-accepted');
  if (saved === 'true') accepted.value = true;
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
        <p class="disclaimer-subtitle">AI 批量视频混剪工具 · v1.2</p>
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
</style>
