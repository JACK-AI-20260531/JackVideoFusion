<script setup lang="ts">
/**
 * 转写文本面板(PRD-文本即时间线 v2.0 FR-1/FR-2)
 *
 * 职责:句级段落列表展示——点击句子跳预览、删句、已删句划线灰显、播放高亮联动
 * 设计要点:纯展示组件,交互全部向上 emit,由父视图调 IPC
 */
export interface PanelSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  deleted: boolean;
}

const props = defineProps<{
  segments: PanelSegment[];
  /** 当前播放中的段落 ID(高亮滚动) */
  activeId?: string;
}>();

const emit = defineEmits<{
  /** 点击句子:请求预览 seek 到句首 */
  (e: 'seek', start: number): void;
  /** 删除该句 */
  (e: 'delete', seg: PanelSegment): void;
}>();

/** 秒 → mm:ss */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
  <div class="transcript-panel">
    <div v-if="segments.length === 0" class="transcript-panel__empty">暂无转写内容</div>
    <div
      v-for="seg in segments"
      :key="seg.id"
      class="seg"
      :class="{
        'seg--deleted': seg.deleted,
        'seg--active': activeId === seg.id && !seg.deleted,
      }"
      :data-seg-id="seg.id"
      @click="emit('seek', seg.start)"
    >
      <span class="seg__text">{{ seg.text }}</span>
      <span class="seg__time">{{ fmt(seg.start) }}-{{ fmt(seg.end) }}</span>
      <button
        v-if="!seg.deleted"
        class="seg__del"
        title="删除该句"
        @click.stop="emit('delete', seg)"
      >✕</button>
      <span v-else class="seg__flag">已删除</span>
    </div>
  </div>
</template>

<style scoped lang="less">
.transcript-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;

  &__empty {
    font-size: 12px;
    color: var(--color-text-tertiary);
    padding: 8px 0;
  }
}

.seg {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 36px 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-primary);
  transition: background 0.15s;

  &:hover {
    background: var(--color-accent-soft);

    .seg__del {
      opacity: 1;
    }
  }

  &--active {
    background: var(--color-accent-soft);
  }

  &--deleted {
    .seg__text {
      text-decoration: line-through;
      color: var(--color-text-tertiary);
    }
    opacity: 0.55;
  }

  &__text {
    flex: 1;
    font-size: 13px;
    line-height: 1.6;
  }

  &__time {
    font-size: 11px;
    color: var(--color-text-tertiary);
    font-family: monospace;
    flex-shrink: 0;
  }

  &__del {
    border: none;
    background: transparent;
    color: var(--color-error);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    opacity: 0;
    transition: opacity 0.15s;

    &:hover {
      opacity: 1;
    }
  }

  &__flag {
    font-size: 10px;
    color: var(--color-text-tertiary);
    border: 1px solid var(--color-border-default);
    border-radius: 8px;
    padding: 0 6px;
    flex-shrink: 0;
  }
}
</style>
