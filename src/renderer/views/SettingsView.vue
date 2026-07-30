<script setup lang="ts">
/**
 * 系统设置视图
 * 职责:展示全局配置(路径、画质、水印、字幕、LLM)、关于页免责声明
 */
import { useConfigStore } from '../stores/config';

const configStore = useConfigStore();

// TODO: Task 002 完成后接入 IPC 加载/保存
</script>

<template>
  <div class="settings-view">
    <h2 class="settings-view__title">系统设置</h2>

    <section class="settings-section">
      <h3 class="settings-section__title">默认导出</h3>
      <div class="settings-row">
        <label>导出目录</label>
        <input v-model="configStore.config.defaultExportDir" placeholder="未设置" />
      </div>
      <div class="settings-row">
        <label>默认分辨率</label>
        <select v-model="configStore.config.defaultResolution">
          <option value="720p">720P</option>
          <option value="1080p">1080P</option>
          <option value="4k">4K</option>
        </select>
      </div>
      <div class="settings-row">
        <label>
          <input v-model="configStore.config.keepOriginalQuality" type="checkbox" />
          保留原画质
        </label>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">LLM 大模型(云端模式可选)</h3>
      <div class="settings-row">
        <label>Provider</label>
        <select v-model="configStore.config.llm.provider">
          <option value="openai">OpenAI</option>
          <option value="qwen">通义千问</option>
          <option value="ollama">Ollama(本地)</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      <div class="settings-row">
        <label>接口地址</label>
        <input v-model="configStore.config.llm.endpoint" placeholder="https://..." />
      </div>
      <div class="settings-row">
        <label>API Key</label>
        <input v-model="configStore.config.llm.apiKey" type="password" placeholder="sk-..." />
      </div>
      <div class="settings-row">
        <label>模型</label>
        <input v-model="configStore.config.llm.model" placeholder="gpt-4o / qwen-max" />
      </div>
    </section>

    <section class="settings-section settings-section--about">
      <h3 class="settings-section__title">关于</h3>
      <p class="settings-section__text">AI智剪工坊 v1.0 · Windows 桌面端 AI 批量视频混剪工具</p>
      <p class="settings-section__disclaimer">
        免责声明:本工具仅为视频剪辑辅助工具,用户需自行保证素材版权合法,禁止用于侵权、搬运、违规内容创作。
        本工具遵循微软 TTS 开源协议,不剥离、不单独售卖语音能力。
      </p>
      <div class="settings-section__actions">
        <button class="btn" @click="configStore.reset">还原默认</button>
        <button class="btn btn--primary" @click="configStore.save">保存设置</button>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.settings-view {
  max-width: 720px;

  &__title {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 24px;
  }
}

.settings-section {
  padding: 20px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  margin-bottom: 16px;

  &__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &__text {
    font-size: 13px;
    color: var(--color-text-secondary);
    margin: 0 0 8px;
  }

  &__disclaimer {
    font-size: 12px;
    color: var(--color-text-tertiary);
    line-height: 1.7;
    margin: 0 0 16px;
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  label {
    width: 100px;
    font-size: 13px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  input, select {
    flex: 1;
    height: 32px;
    padding: 0 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    color: var(--color-text-primary);
    font-size: 13px;
    outline: none;

    &:focus { border-color: var(--color-accent); }
  }
}
</style>
