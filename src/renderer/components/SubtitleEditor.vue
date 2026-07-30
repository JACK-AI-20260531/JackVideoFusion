<script setup lang="ts">
/**
 * 字幕样式编辑器组件
 * 职责:编辑字幕样式(字体/大小/颜色/描边/阴影/对齐),
 *       提供实时预览(显示示例字幕文字应用样式)
 */
import { computed } from 'vue';
import type { SubtitleStyleConfig } from '@shared/types';

// Props: v-model 绑定的字幕样式配置
const props = defineProps<{
  modelValue: SubtitleStyleConfig;
}>();

// Emits: 配置变更通知
const emit = defineEmits<{
  (e: 'update:modelValue', value: SubtitleStyleConfig): void;
}>();

// 系统预设字体列表
const FONT_FAMILIES: string[] = [
  '微软雅黑',
  '宋体',
  '黑体',
  '仿宋',
  '楷体',
  'Arial',
  'Times New Roman',
];

// 对齐方式列表
const ALIGN_OPTIONS: { value: SubtitleStyleConfig['align']; label: string }[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
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
function updateField(patch: Partial<SubtitleStyleConfig>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

/**
 * 选择自定义字体文件(.ttf)
 */
async function pickFontFile(): Promise<void> {
  const res = await getApi().invoke<{ title?: string; filters?: { name: string; extensions: string[] }[] }, string>(
    'dialog:openFile',
    {
      title: '选择字体文件',
      filters: [
        { name: '字体文件', extensions: ['ttf', 'otf', 'ttc'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    },
  );
  if (res.ok && res.data) {
    // 自定义字体文件路径存入 fontFamily 字段(带 file:// 前缀标识)
    updateField({ fontFamily: res.data });
  }
}

// 预览文字样式(响应式)
const previewTextStyle = computed(() => {
  const cfg = props.modelValue;
  const style: Record<string, string> = {
    fontFamily: cfg.fontFamily,
    fontSize: `${Math.min(cfg.fontSize, 48)}px`,
    color: cfg.color,
    textAlign: cfg.align,
  };
  if (cfg.outline) {
    style.textShadow = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
  }
  if (cfg.shadow) {
    style.textShadow = style.textShadow
      ? `${style.textShadow}, 2px 2px 4px rgba(0,0,0,0.6)`
      : '2px 2px 4px rgba(0,0,0,0.6)';
  }
  return style;
});
</script>

<template>
  <div class="subtitle-editor">
    <!-- 启用开关 -->
    <div class="se-row">
      <label class="se-label">启用字幕</label>
      <label class="se-switch">
        <input
          type="checkbox"
          :checked="modelValue.enabled"
          @change="updateField({ enabled: ($event.target as HTMLInputElement).checked })"
        />
        <span>{{ modelValue.enabled ? '已启用' : '未启用' }}</span>
      </label>
    </div>

    <!-- 字体选择 -->
    <div class="se-row">
      <label class="se-label">字体</label>
      <select
        class="se-select"
        :value="FONT_FAMILIES.includes(modelValue.fontFamily) ? modelValue.fontFamily : ''"
        @change="updateField({ fontFamily: ($event.target as HTMLSelectElement).value || modelValue.fontFamily })"
      >
        <option value="">自定义字体文件</option>
        <option v-for="font in FONT_FAMILIES" :key="font" :value="font">{{ font }}</option>
      </select>
      <button class="se-pick-btn" @click="pickFontFile">选择 .ttf</button>
    </div>

    <!-- 字号 -->
    <div class="se-row">
      <label class="se-label">字号</label>
      <input
        class="se-input se-input--narrow"
        type="number"
        min="8"
        max="72"
        :value="modelValue.fontSize"
        @input="updateField({ fontSize: parseInt(($event.target as HTMLInputElement).value, 10) || 24 })"
      />
      <span class="se-unit">px</span>
    </div>

    <!-- 颜色 -->
    <div class="se-row">
      <label class="se-label">字体颜色</label>
      <input
        class="se-color"
        type="color"
        :value="modelValue.color"
        @input="updateField({ color: ($event.target as HTMLInputElement).value })"
      />
      <span class="se-color-value">{{ modelValue.color }}</span>
    </div>

    <!-- 描边与阴影 -->
    <div class="se-row">
      <label class="se-label">描边</label>
      <label class="se-switch">
        <input
          type="checkbox"
          :checked="modelValue.outline"
          @change="updateField({ outline: ($event.target as HTMLInputElement).checked })"
        />
        <span>{{ modelValue.outline ? '开' : '关' }}</span>
      </label>
      <label class="se-label se-label--ml">阴影</label>
      <label class="se-switch">
        <input
          type="checkbox"
          :checked="modelValue.shadow"
          @change="updateField({ shadow: ($event.target as HTMLInputElement).checked })"
        />
        <span>{{ modelValue.shadow ? '开' : '关' }}</span>
      </label>
    </div>

    <!-- 对齐方式 -->
    <div class="se-row">
      <label class="se-label">对齐方式</label>
      <div class="se-align-group">
        <button
          v-for="opt in ALIGN_OPTIONS"
          :key="opt.value"
          class="se-align-btn"
          :class="{ 'se-align-btn--active': modelValue.align === opt.value }"
          @click="updateField({ align: opt.value })"
        >{{ opt.label }}</button>
      </div>
    </div>

    <!-- 预览 -->
    <div class="se-preview">
      <div class="se-preview-label">预览</div>
      <div class="se-preview-box">
        <span class="se-preview-text" :style="previewTextStyle">示例字幕文字</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.subtitle-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.se-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.se-label {
  width: 80px;
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-shrink: 0;

  &--ml {
    margin-left: 16px;
  }
}

.se-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input { cursor: pointer; }
}

.se-select {
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
}

.se-input {
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
}

.se-unit {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.se-color {
  width: 40px;
  height: 28px;
  padding: 2px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  cursor: pointer;
}

.se-color-value {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: monospace;
}

.se-pick-btn {
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

.se-align-group {
  display: flex;
  gap: 4px;
}

.se-align-btn {
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

.se-preview {
  margin-top: 4px;
}

.se-preview-label {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin-bottom: 6px;
}

.se-preview-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 80px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.se-preview-text {
  display: block;
  width: 100%;
  padding: 0 16px;
  line-height: 1.5;
}
</style>
