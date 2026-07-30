<script setup lang="ts">
/**
 * AI剪辑视图(占位)
 * 实际功能由 V1.1 实现:本地CLIP + 云端LLM 双模式智能成片
 */
</script>

<template>
  <div class="view-placeholder">
    <h2 class="view-placeholder__title">AI剪辑</h2>
    <p class="view-placeholder__desc">基于音频/字幕语义自动匹配素材画面,一键全自动成片(本地CLIP + 云端LLM双模式)</p>
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
