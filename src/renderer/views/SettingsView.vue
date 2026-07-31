<script setup lang="ts">
/**
 * 系统设置视图
 * 职责:展示全局配置(分辨率/导出路径/水印/字幕/并发/LLM),
 *       嵌入 WatermarkEditor 与 SubtitleEditor 组件,支持保存与恢复默认
 */
import { onMounted } from 'vue';
import { useConfigStore } from '../stores/config';
import WatermarkEditor from '../components/WatermarkEditor.vue';
import SubtitleEditor from '../components/SubtitleEditor.vue';

// 配置仓库
const configStore = useConfigStore();

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
 * 选择导出目录(调用 dialog:openDirectory IPC)
 */
async function pickExportDir(): Promise<void> {
  const res = await getApi().invoke<{ title?: string }, string>('dialog:openDirectory', {
    title: '选择默认导出目录',
  });
  if (res.ok && res.data) {
    configStore.config.defaultExportDir = res.data;
  }
}

/**
 * 保存配置
 */
async function handleSave(): Promise<void> {
  await configStore.save();
}

/**
 * 恢复默认配置
 */
async function handleReset(): Promise<void> {
  await configStore.reset();
}

// 挂载时加载配置
onMounted(() => {
  // IPC 调用兜底:主进程未就绪时不抛未处理 rejection
  configStore.load().catch(() => {});
});
</script>

<template>
  <div class="settings-view">
    <h2 class="settings-view__title">系统设置</h2>

    <!-- 分辨率与导出设置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">分辨率与导出</h3>
      <div class="settings-row">
        <label>默认分辨率</label>
        <div class="settings-radio-group">
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="720p" />
            720P
          </label>
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="1080p" />
            1080P
          </label>
          <label class="settings-radio">
            <input v-model="configStore.config.defaultResolution" type="radio" value="4k" />
            4K
          </label>
        </div>
      </div>
      <div class="settings-row">
        <label>
          <input v-model="configStore.config.keepOriginalQuality" type="checkbox" />
          保留原画质(不强制缩放)
        </label>
      </div>
      <div class="settings-row">
        <label>导出目录</label>
        <input
          v-model="configStore.config.defaultExportDir"
          placeholder="未设置则使用 userData/exports"
        />
        <button class="btn" @click="pickExportDir">选择目录</button>
      </div>
    </section>

    <!-- 水印配置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">水印配置</h3>
      <WatermarkEditor v-model="configStore.config.watermark" />
    </section>

    <!-- 字幕配置 -->
    <section class="settings-section">
      <h3 class="settings-section__title">字幕配置</h3>
      <SubtitleEditor v-model="configStore.config.subtitle" />
    </section>

    <!-- 任务并发 -->
    <section class="settings-section">
      <h3 class="settings-section__title">任务执行</h3>
      <div class="settings-row">
        <label>任务并发数</label>
        <input
          v-model.number="configStore.config.taskConcurrency"
          type="number"
          min="1"
          max="4"
          class="settings-input--narrow"
        />
        <span class="settings-hint">(1-4,建议 1 避免磁盘抢占)</span>
      </div>
    </section>

    <!-- LLM 大模型 -->
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

    <!-- 关于 -->
    <section class="settings-section settings-section--about">
      <h3 class="settings-section__title">关于</h3>
      <p class="settings-section__text">AI智剪工坊 v1.2.0 · Windows 桌面端 AI 批量视频混剪工具</p>
      <p class="settings-section__disclaimer">
        免责声明:本工具仅为视频剪辑辅助工具,用户需自行保证素材版权合法,禁止用于侵权、搬运、违规内容创作。
        本工具遵循微软 TTS 开源协议,不剥离、不单独售卖语音能力。
      </p>
    </section>

    <!-- 底部操作按钮 -->
    <div class="settings-footer">
      <!-- 操作反馈消息 -->
      <span v-if="configStore.message" class="settings-footer__msg">{{ configStore.message }}</span>
      <div class="settings-footer__actions">
        <button class="btn" @click="handleReset">恢复默认</button>
        <button class="btn btn--primary" @click="handleSave">保存设置</button>
      </div>
    </div>
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
    margin: 0;
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

.settings-input--narrow {
  width: 80px !important;
  flex: none !important;
}

.settings-radio-group {
  display: flex;
  gap: 16px;
}

.settings-radio {
  display: flex;
  align-items: center;
  gap: 4px;
  width: auto !important;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input { width: auto; flex: none; cursor: pointer; }
}

.settings-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;

  &__msg {
    font-size: 13px;
    color: var(--color-success);
  }

  &__actions {
    display: flex;
    gap: 8px;
  }
}
</style>
