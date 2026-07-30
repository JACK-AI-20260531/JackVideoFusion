<script setup lang="ts">
/**
 * 视频混剪视图(占位)
 * 实际功能由 Task 008 实现:随机素材混剪 + 文件夹音频匹配合成
 */
</script>

<template>
  <div class="view-placeholder">
    <h2 class="view-placeholder__title">视频混剪</h2>
    <p class="view-placeholder__desc">两大核心混剪模式:随机素材混剪、文件夹音频匹配合成</p>
    <div class="view-placeholder__badge">Task 008 待实现</div>
  </div>
</template>

<style scoped lang="less">
.view-placeholder {
  &__title { font-size: 20px; font-weight: 600; color: var(--color-text-primary); margin: 0 0 8px; }
  &__desc { font-size: 13px; color: var(--color-text-secondary); margin: 0 0 16px; }
  &__badge { display: inline-block; padding: 4px 10px; background: var(--color-accent-soft); color: var(--color-accent); border: 1px solid var(--color-accent); border-radius: 4px; font-size: 11px; }
}
</style>
