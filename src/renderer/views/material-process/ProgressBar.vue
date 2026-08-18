<script setup lang="ts">
/**
 * 进度条组件
 * 职责:以 div + width 百分比形式展示任务进度,支持状态色区分
 */
interface Props {
  // 进度值 0-100
  progress: number;
  // 状态:idle 灰色 / running 蓝色 / paused 暂停色 / completed 成功色 / failed 错误色
  status?: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
}

const props = withDefaults(defineProps<Props>(), {
  status: 'idle',
});
</script>

<template>
  <div class="progress-bar">
    <div class="progress-bar__track">
      <div
        class="progress-bar__fill"
        :class="`progress-bar__fill--${props.status}`"
        :style="{ width: `${Math.min(100, Math.max(0, props.progress))}%` }"
      />
    </div>
    <span class="progress-bar__label">{{ Math.round(props.progress) }}%</span>
  </div>
</template>

<style scoped lang="less">
.progress-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;

  &__track {
    flex: 1;
    height: 6px;
    background: var(--color-bg-sunken);
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid var(--color-border-subtle);
  }

  &__fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease, background 0.2s;
    background: var(--color-border-strong);

    &--running {
      background: var(--color-accent);
    }
    &--paused {
      background: var(--color-warning);
    }
    &--completed {
      background: var(--color-success);
    }
    &--failed {
      background: var(--color-error);
    }
  }

  &__label {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-text-tertiary);
    min-width: 36px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
}
</style>
