<script setup lang="ts">
/**
 * 影视解说克隆视图(占位)
 * 实际功能由 V1.1 实现:复刻参考解说视频剪辑节奏,用自有素材生成全新原创解说
 */
</script>

<template>
  <div class="view-placeholder">
    <h2 class="view-placeholder__title">影视解说克隆</h2>
    <p class="view-placeholder__desc">复刻优质影视解说视频的剪辑节奏、镜头逻辑,用自有素材生成全新原创解说视频(二次创作)</p>
    <div class="view-placeholder__badge">V1.1 待实现</div>
  </div>
</template>

<style scoped lang="less">
.view-placeholder {
  &__title { font-size: 20px; font-weight: 600; color: var(--color-text-primary); margin: 0 0 8px; }
  &__desc { font-size: 13px; color: var(--color-text-secondary); margin: 0 0 16px; }
  &__badge { display: inline-block; padding: 4px 10px; background: var(--color-accent-soft); color: var(--color-accent); border: 1px solid var(--color-accent); border-radius: 4px; font-size: 11px; }
}
</style>
