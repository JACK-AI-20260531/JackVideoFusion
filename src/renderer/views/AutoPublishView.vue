<script setup lang="ts">
/**
 * 自动发布视图(占位)
 * 实际功能由 V1.2 实现:多平台账号管理、批量上传、定时发布
 */
</script>

<template>
  <div class="view-placeholder">
    <h2 class="view-placeholder__title">自动发布</h2>
    <p class="view-placeholder__desc">多平台账号管理、批量上传视频、定时发布(抖音/快手/小红书/视频号/B站)</p>
    <div class="view-placeholder__badge">V1.2 待实现</div>
    <p class="view-placeholder__notice">本功能仅作自动化发布辅助,请遵守各平台运营规则。</p>
  </div>
</template>

<style scoped lang="less">
.view-placeholder {
  &__title { font-size: 20px; font-weight: 600; color: var(--color-text-primary); margin: 0 0 8px; }
  &__desc { font-size: 13px; color: var(--color-text-secondary); margin: 0 0 16px; }
  &__badge { display: inline-block; padding: 4px 10px; background: var(--color-accent-soft); color: var(--color-accent); border: 1px solid var(--color-accent); border-radius: 4px; font-size: 11px; }
  &__notice { margin-top: 16px; font-size: 12px; color: var(--color-warning); }
}
</style>
