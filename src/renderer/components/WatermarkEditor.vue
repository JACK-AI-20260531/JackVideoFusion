<script setup lang="ts">
/**
 * 水印编辑器组件
 * 职责:编辑水印配置(类型/内容/位置/透明度/边距),
 *       提供九宫格位置选择器与 16:9 实时预览
 */
import { computed } from 'vue';
import type { WatermarkConfig, WatermarkPosition } from '@shared/types';

// Props: v-model 绑定的水印配置
const props = defineProps<{
  modelValue: WatermarkConfig;
}>();

// Emits: 配置变更通知
const emit = defineEmits<{
  (e: 'update:modelValue', value: WatermarkConfig): void;
}>();

// 九宫格位置列表(3x3 布局)
const POSITIONS: WatermarkPosition[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/**
 * 更新配置中的单个字段
 * @param patch 部分字段
 */
function updateField(patch: Partial<WatermarkConfig>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

/**
 * 选择图片水印文件(调用 dialog:openFile)
 */
async function pickImage(): Promise<void> {
  const res = await getApi().invoke<{ title?: string; filters?: { name: string; extensions: string[] }[] }, string>(
    'dialog:openFile',
    {
      title: '选择水印图片',
      filters: [
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    },
  );
  if (res.ok && res.data) {
    updateField({ content: res.data });
  }
}

/**
 * 根据位置计算预览水印的 CSS 样式
 * @param position 九宫格位置
 * @param marginX 水平边距(预览中等比缩小)
 * @param marginY 垂直边距
 * @returns CSS 样式对象
 */
function previewStyle(
  position: WatermarkPosition,
  marginX: number,
  marginY: number,
): Record<string, string> {
  // 预览框宽度约 320px,边距按比例缩小(实际 20px → 预览约 5px)
  const mx = Math.max(2, Math.round(marginX / 4));
  const my = Math.max(2, Math.round(marginY / 4));
  const style: Record<string, string> = {};
  switch (position) {
    case 'top-left':
      style.top = `${my}px`;
      style.left = `${mx}px`;
      break;
    case 'top-center':
      style.top = `${my}px`;
      style.left = '50%';
      style.transform = 'translateX(-50%)';
      break;
    case 'top-right':
      style.top = `${my}px`;
      style.right = `${mx}px`;
      break;
    case 'middle-left':
      style.top = '50%';
      style.left = `${mx}px`;
      style.transform = 'translateY(-50%)';
      break;
    case 'center':
      style.top = '50%';
      style.left = '50%';
      style.transform = 'translate(-50%, -50%)';
      break;
    case 'middle-right':
      style.top = '50%';
      style.right = `${mx}px`;
      style.transform = 'translateY(-50%)';
      break;
    case 'bottom-left':
      style.bottom = `${my}px`;
      style.left = `${mx}px`;
      break;
    case 'bottom-center':
      style.bottom = `${my}px`;
      style.left = '50%';
      style.transform = 'translateX(-50%)';
      break;
    case 'bottom-right':
      style.bottom = `${my}px`;
      style.right = `${mx}px`;
      break;
  }
  return style;
}

// 预览水印样式(响应式)
const watermarkPreviewStyle = computed(() =>
  previewStyle(
    props.modelValue.position,
    props.modelValue.marginX,
    props.modelValue.marginY,
  ),
);

// 预览透明度(CSS opacity 0-1)
const previewOpacity = computed(() => props.modelValue.opacity / 100);
</script>

<template>
  <div class="watermark-editor">
    <!-- 启用开关 -->
    <div class="we-row">
      <label class="we-label">启用水印</label>
      <label class="we-switch">
        <input
          type="checkbox"
          :checked="modelValue.enabled"
          @change="updateField({ enabled: ($event.target as HTMLInputElement).checked })"
        />
        <span>{{ modelValue.enabled ? '已启用' : '未启用' }}</span>
      </label>
    </div>

    <!-- 水印类型切换 -->
    <div class="we-row">
      <label class="we-label">水印类型</label>
      <div class="we-type-group">
        <button
          class="we-type-btn"
          :class="{ 'we-type-btn--active': modelValue.type === 'text' }"
          @click="updateField({ type: 'text' })"
        >文本水印</button>
        <button
          class="we-type-btn"
          :class="{ 'we-type-btn--active': modelValue.type === 'image' }"
          @click="updateField({ type: 'image' })"
        >图片水印</button>
      </div>
    </div>

    <!-- 文本水印内容 -->
    <div v-if="modelValue.type === 'text'" class="we-row">
      <label class="we-label">水印文字</label>
      <input
        class="we-input"
        type="text"
        :value="modelValue.content"
        placeholder="请输入水印文字"
        @input="updateField({ content: ($event.target as HTMLInputElement).value })"
      />
    </div>

    <!-- 图片水印路径 -->
    <div v-else class="we-row">
      <label class="we-label">水印图片</label>
      <input
        class="we-input we-input--path"
        type="text"
        :value="modelValue.content"
        placeholder="请选择图片文件"
        readonly
      />
      <button class="we-pick-btn" @click="pickImage">选择图片</button>
    </div>

    <!-- 位置九宫格选择器 -->
    <div class="we-row">
      <label class="we-label">水印位置</label>
      <div class="we-grid">
        <button
          v-for="pos in POSITIONS"
          :key="pos"
          class="we-grid-btn"
          :class="{ 'we-grid-btn--active': modelValue.position === pos }"
          :title="pos"
          @click="updateField({ position: pos })"
        >
          <span class="we-grid-dot"></span>
        </button>
      </div>
    </div>

    <!-- 透明度滑块 -->
    <div class="we-row">
      <label class="we-label">透明度</label>
      <input
        class="we-slider"
        type="range"
        min="0"
        max="100"
        :value="modelValue.opacity"
        @input="updateField({ opacity: parseInt(($event.target as HTMLInputElement).value, 10) })"
      />
      <span class="we-value">{{ modelValue.opacity }}%</span>
    </div>

    <!-- 边距输入 -->
    <div class="we-row">
      <label class="we-label">水平边距</label>
      <input
        class="we-input we-input--narrow"
        type="number"
        min="0"
        :value="modelValue.marginX"
        @input="updateField({ marginX: parseInt(($event.target as HTMLInputElement).value, 10) || 0 })"
      />
      <label class="we-label we-label--ml">垂直边距</label>
      <input
        class="we-input we-input--narrow"
        type="number"
        min="0"
        :value="modelValue.marginY"
        @input="updateField({ marginY: parseInt(($event.target as HTMLInputElement).value, 10) || 0 })"
      />
    </div>

    <!-- 实时预览 -->
    <div class="we-preview">
      <div class="we-preview-label">预览</div>
      <div class="we-preview-box">
        <div
          v-if="modelValue.enabled"
          class="we-preview-watermark"
          :style="{ ...watermarkPreviewStyle, opacity: previewOpacity }"
        >
          <span
            v-if="modelValue.type === 'text'"
            class="we-preview-text"
            :style="{ fontSize: `${(modelValue.fontSize ?? 24) / 3}px`, color: modelValue.fontColor ?? 'white' }"
          >{{ modelValue.content || '水印示例' }}</span>
          <img
            v-else-if="modelValue.content"
            class="we-preview-img"
            :src="`file://${modelValue.content}`"
            alt="水印预览"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.watermark-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.we-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.we-label {
  width: 80px;
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-shrink: 0;

  &--ml {
    margin-left: 16px;
  }
}

.we-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input { cursor: pointer; }
}

.we-type-group {
  display: flex;
  gap: 4px;
}

.we-type-btn {
  height: 28px;
  padding: 0 12px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;

  &:hover { border-color: var(--color-border-strong); }

  &--active {
    background: var(--color-accent-soft);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
}

.we-input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;

  &:focus { border-color: var(--color-accent); }

  &--narrow { width: 80px; flex: none; }
  &--path { flex: 1; }
}

.we-pick-btn {
  height: 28px;
  padding: 0 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;

  &:hover { background: var(--color-bg-hover); }
}

.we-grid {
  display: grid;
  grid-template-columns: repeat(3, 28px);
  grid-template-rows: repeat(3, 28px);
  gap: 3px;
}

.we-grid-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 3px;
  cursor: pointer;

  &:hover { border-color: var(--color-border-strong); }

  &--active {
    background: var(--color-accent-soft);
    border-color: var(--color-accent);

    .we-grid-dot { background: var(--color-accent); }
  }
}

.we-grid-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
}

.we-slider {
  flex: 1;
  height: 4px;
  cursor: pointer;
  accent-color: var(--color-accent);
}

.we-value {
  width: 40px;
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: right;
}

.we-preview {
  margin-top: 4px;
}

.we-preview-label {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin-bottom: 6px;
}

.we-preview-box {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.we-preview-watermark {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
}

.we-preview-text {
  font-size: 8px;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.we-preview-img {
  max-width: 20%;
  max-height: 20%;
  object-fit: contain;
}
</style>
