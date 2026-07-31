<script setup lang="ts">
/**
 * 自动发布视图
 *
 * 职责:多平台账号管理、视频批量发布、定时发布、发布任务队列展示
 *
 * 调用 IPC:
 *   auto-publish:listAccounts  - 加载所有平台账号状态
 *   auto-publish:login         - 扫码登录指定平台
 *   auto-publish:checkLogin    - 检查登录状态(打开浏览器精确检测)
 *   auto-publish:logout        - 退出登录
 *   auto-publish:publish       - 发布视频(入队串行执行)
 *   auto-publish:batchPublish  - 批量发布
 *   auto-publish:cancel        - 取消发布任务
 *   dialog:openFile            - 选择视频/封面文件
 *   task:progress              - 订阅任务进度推送
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import ProgressBar from './material-process/ProgressBar.vue';
import type { TaskStatus } from '@shared/types';

/** 支持的平台标识 */
type PublishPlatform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'bilibili';

/** 登录状态 */
type LoginStatus = 'logged-out' | 'logged-in' | 'expired';

/** 平台账号信息 */
interface AccountInfo {
  platform: PublishPlatform;
  nickname?: string;
  avatar?: string;
  loginStatus: LoginStatus;
  lastActiveAt?: string;
}

/** 发布参数 */
interface PublishParams {
  platform: PublishPlatform;
  videoPath: string;
  title: string;
  description?: string;
  tags?: string[];
  coverPath?: string;
  scheduledAt?: string;
}

/** 任务列表项(本地维护,与 task:progress 推送同步) */
interface PublishTaskView {
  taskId: string;
  platform: PublishPlatform;
  title: string;
  status: TaskStatus;
  progress: number;
  error?: string;
  videoUrl?: string;
  createdAt: string;
}

/** 平台中文名映射 */
const PLATFORM_NAMES: Record<PublishPlatform, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
};

/** 全部平台列表 */
const ALL_PLATFORMS: PublishPlatform[] = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili'];

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

// ===== 账号管理 =====
/** 各平台账号状态(以平台为键) */
const accounts = ref<Record<PublishPlatform, AccountInfo>>({
  douyin: { platform: 'douyin', loginStatus: 'logged-out' },
  kuaishou: { platform: 'kuaishou', loginStatus: 'logged-out' },
  xiaohongshu: { platform: 'xiaohongshu', loginStatus: 'logged-out' },
  bilibili: { platform: 'bilibili', loginStatus: 'logged-out' },
});
/** 正在登录的平台集合 */
const loggingPlatforms = ref<Set<PublishPlatform>>(new Set());
/** 正在检测登录的平台集合 */
const checkingPlatforms = ref<Set<PublishPlatform>>(new Set());

// ===== 发布表单 =====
const videoPath = ref('');
const title = ref('');
const description = ref('');
const tagsInput = ref('');
const coverPath = ref('');
const scheduledAt = ref('');
const selectedPlatforms = ref<PublishPlatform[]>([]);

// ===== 任务列表 =====
const publishTasks = ref<PublishTaskView[]>([]);
const submitting = ref(false);
const error = ref<string | null>(null);

// ===== 计算属性 =====
/** 是否可添加到队列:视频路径 + 标题 + 至少一个平台 + 未在提交 */
const canSubmit = computed(
  () =>
    videoPath.value.trim().length > 0 &&
    title.value.trim().length > 0 &&
    selectedPlatforms.value.length > 0 &&
    !submitting.value,
);

/**
 * 获取登录状态的展示文本
 * @param status 登录状态
 * @returns 中文文本
 */
function statusText(status: LoginStatus): string {
  switch (status) {
    case 'logged-in':
      return '已登录';
    case 'expired':
      return '已过期';
    case 'logged-out':
    default:
      return '未登录';
  }
}

/**
 * 获取登录状态对应的样式类
 * @param status 登录状态
 * @returns 样式类名
 */
function statusClass(status: LoginStatus): string {
  return `status--${status}`;
}

/**
 * 获取任务状态的进度条状态
 * @param status 任务状态
 * @returns 进度条状态
 */
function progressStatus(status: TaskStatus): 'idle' | 'running' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'idle';
}

/**
 * 任务状态中文文本
 * @param status 任务状态
 * @returns 中文文本
 */
function taskStatusText(status: TaskStatus): string {
  switch (status) {
    case 'pending':
      return '排队中';
    case 'running':
      return '发布中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'paused':
      return '已暂停';
    default:
      return '未知';
  }
}

// 进度订阅取消函数
let unsubscribe: (() => void) | null = null;

/**
 * 组件挂载:加载账号列表,订阅任务进度
 */
onMounted(async () => {
  try {
    await loadAccounts();
  } catch {
    // 降级:保持默认未登录状态
  }

  // 订阅 task:progress 更新任务列表
  unsubscribe = getApi().on('task:progress', (...args: unknown[]) => {
    const data = args[0] as {
      id: string;
      status: TaskStatus;
      progress: number;
      output?: string;
      error?: string;
    } | undefined;
    if (!data) return;
    const task = publishTasks.value.find((t) => t.taskId === data.id);
    if (!task) return;
    task.status = data.status;
    task.progress = data.progress;
    if (data.error) task.error = data.error;
    if (data.output) task.videoUrl = data.output;
  });
});

/**
 * 组件卸载:取消进度订阅
 */
onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

/**
 * 加载所有平台账号状态
 */
async function loadAccounts(): Promise<void> {
  const res = await getApi().invoke<unknown, AccountInfo[]>('auto-publish:listAccounts');
  if (res.ok && res.data) {
    for (const acc of res.data) {
      accounts.value[acc.platform] = acc;
    }
  }
}

/**
 * 扫码登录指定平台
 * @param platform 平台标识
 */
async function handleLogin(platform: PublishPlatform): Promise<void> {
  loggingPlatforms.value.add(platform);
  error.value = null;
  try {
    const res = await getApi().invoke<{ platform: PublishPlatform }, AccountInfo>(
      'auto-publish:login',
      { platform },
    );
    if (res.ok && res.data) {
      accounts.value[platform] = res.data;
    } else {
      error.value = res.error ?? `${PLATFORM_NAMES[platform]} 登录失败`;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loggingPlatforms.value.delete(platform);
  }
}

/**
 * 检查指定平台登录状态(打开浏览器精确检测)
 * @param platform 平台标识
 */
async function handleCheckLogin(platform: PublishPlatform): Promise<void> {
  checkingPlatforms.value.add(platform);
  try {
    const res = await getApi().invoke<{ platform: PublishPlatform }, AccountInfo>(
      'auto-publish:checkLogin',
      { platform },
    );
    if (res.ok && res.data) {
      accounts.value[platform] = res.data;
    }
  } catch {
    // 忽略检测错误
  } finally {
    checkingPlatforms.value.delete(platform);
  }
}

/**
 * 退出指定平台登录
 * @param platform 平台标识
 */
async function handleLogout(platform: PublishPlatform): Promise<void> {
  try {
    const res = await getApi().invoke<{ platform: PublishPlatform }, { loggedOut: boolean }>(
      'auto-publish:logout',
      { platform },
    );
    if (res.ok) {
      accounts.value[platform] = {
        platform,
        loginStatus: 'logged-out',
      };
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/**
 * 选择视频文件
 */
async function handlePickVideo(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFile', {
    title: '选择视频文件',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv'] }],
  });
  if (res.ok && res.data && res.data.length > 0) {
    videoPath.value = res.data[0];
  }
}

/**
 * 选择封面图片
 */
async function handlePickCover(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFile', {
    title: '选择封面图片',
    filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (res.ok && res.data && res.data.length > 0) {
    coverPath.value = res.data[0];
  }
}

/**
 * 解析话题输入为标签数组
 * @returns 标签数组(去空去重)
 */
function parseTags(): string[] {
  return tagsInput.value
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * 添加发布任务到队列(对每个选中平台创建一个任务)
 */
async function handleEnqueue(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const tags = parseTags();
    // 定时时间转 ISO(空则 undefined)
    const scheduled =
      scheduledAt.value.trim().length > 0
        ? new Date(scheduledAt.value).toISOString()
        : undefined;

    // 对每个选中平台创建发布任务
    const items: PublishParams[] = selectedPlatforms.value.map((platform) => ({
      platform,
      videoPath: videoPath.value,
      title: title.value,
      description: description.value || undefined,
      tags: tags.length > 0 ? tags : undefined,
      coverPath: coverPath.value || undefined,
      scheduledAt: scheduled,
    }));

    // 单平台用 publish,多平台用 batchPublish
    let taskIds: string[] = [];
    if (items.length === 1) {
      const res = await getApi().invoke<PublishParams, { taskId: string }>(
        'auto-publish:publish',
        items[0],
      );
      if (res.ok && res.data) {
        taskIds = [res.data.taskId];
      } else {
        error.value = res.error ?? '入队失败';
      }
    } else {
      const res = await getApi().invoke<{ items: PublishParams[] }, { taskIds: string[] }>(
        'auto-publish:batchPublish',
        { items },
      );
      if (res.ok && res.data) {
        taskIds = res.data.taskIds;
      } else {
        error.value = res.error ?? '批量入队失败';
      }
    }

    // 加入本地任务列表
    const now = new Date().toISOString();
    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i];
      const platform = items[i].platform;
      publishTasks.value.unshift({
        taskId: id,
        platform,
        title: title.value,
        status: 'pending',
        progress: 0,
        createdAt: now,
      });
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

/**
 * 取消发布任务
 * @param taskId 任务 ID
 */
async function handleCancelTask(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { cancelled: string }>('auto-publish:cancel', {
    taskId,
  });
}

/**
 * 清空已完成/失败/取消的任务
 */
function handleClearFinished(): void {
  publishTasks.value = publishTasks.value.filter(
    (t) => t.status === 'pending' || t.status === 'running' || t.status === 'paused',
  );
}
</script>

<template>
  <div class="auto-publish-view">
    <!-- 合规提示(顶部固定) -->
    <div class="compliance-notice">
      ⚠️ 请遵守各平台运营规则,自动化发布存在账号风险,使用本功能风险自负。
    </div>

    <!-- 页面标题 -->
    <div class="view-header">
      <h2 class="view-title">自动发布</h2>
      <p class="view-desc">
        多平台账号管理、批量上传视频、定时发布(抖音/快手/小红书/B站)
      </p>
    </div>

    <!-- 平台账号管理区 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">平台账号</h3>
        <button class="btn btn--small" @click="loadAccounts">刷新状态</button>
      </div>
      <div class="platform-grid">
        <div
          v-for="platform in ALL_PLATFORMS"
          :key="platform"
          class="platform-card"
          :class="{ 'platform-card--active': accounts[platform].loginStatus === 'logged-in' }"
        >
          <div class="platform-card__head">
            <span class="platform-card__name">{{ PLATFORM_NAMES[platform] }}</span>
            <span class="platform-card__status" :class="statusClass(accounts[platform].loginStatus)">
              {{ statusText(accounts[platform].loginStatus) }}
            </span>
          </div>
          <div class="platform-card__actions">
            <button
              v-if="accounts[platform].loginStatus !== 'logged-in'"
              class="btn btn--small btn--primary"
              :disabled="loggingPlatforms.has(platform)"
              @click="handleLogin(platform)"
            >
              {{ loggingPlatforms.has(platform) ? '登录中...' : '扫码登录' }}
            </button>
            <button
              v-else
              class="btn btn--small"
              :disabled="loggingPlatforms.has(platform)"
              @click="handleLogout(platform)"
            >
              退出登录
            </button>
            <button
              class="btn btn--small"
              :disabled="checkingPlatforms.has(platform)"
              @click="handleCheckLogin(platform)"
            >
              {{ checkingPlatforms.has(platform) ? '检测中...' : '检测状态' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 发布任务区 -->
    <section class="form-section">
      <h3 class="section-title">发布任务</h3>
      <div class="form-row">
        <label class="form-label">视频文件</label>
        <div class="form-input-group">
          <input v-model="videoPath" class="form-input" placeholder="请选择视频文件" readonly />
          <button class="btn btn--small" @click="handlePickVideo">选择视频</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">标题</label>
        <input v-model="title" class="form-input" placeholder="请输入视频标题" />
      </div>
      <div class="form-row">
        <label class="form-label">描述</label>
        <textarea
          v-model="description"
          class="form-textarea form-textarea--small"
          placeholder="视频描述(可选)"
          rows="3"
        />
      </div>
      <div class="form-row">
        <label class="form-label">话题</label>
        <input v-model="tagsInput" class="form-input" placeholder="多个话题用逗号或空格分隔,如:搞笑,日常" />
      </div>
      <div class="form-row">
        <label class="form-label">封面</label>
        <div class="form-input-group">
          <input v-model="coverPath" class="form-input" placeholder="封面图片(可选)" readonly />
          <button class="btn btn--small" @click="handlePickCover">选择图片</button>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">定时发布</label>
        <input v-model="scheduledAt" type="datetime-local" class="form-input form-input--narrow" />
        <span class="form-hint">留空则立即发布(部分平台不支持定时)</span>
      </div>
      <div class="form-row form-row--inline">
        <label class="form-label">发布平台</label>
        <label
          v-for="platform in ALL_PLATFORMS"
          :key="platform"
          class="form-checkbox"
        >
          <input
            type="checkbox"
            :value="platform"
            v-model="selectedPlatforms"
          />
          {{ PLATFORM_NAMES[platform] }}
        </label>
      </div>
    </section>

    <!-- 操作区 -->
    <div class="action-bar">
      <button class="btn btn--primary" :disabled="!canSubmit" @click="handleEnqueue">
        {{ submitting ? '入队中...' : '添加到发布队列' }}
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="error-msg">{{ error }}</div>

    <!-- 任务列表区 -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">发布队列</h3>
        <button class="btn btn--small" @click="handleClearFinished">清理已完成</button>
      </div>
      <div v-if="publishTasks.length === 0" class="empty-hint">
        暂无发布任务,请在上方填写信息后添加到队列
      </div>
      <div v-else class="task-list">
        <div v-for="task in publishTasks" :key="task.taskId" class="task-item">
          <div class="task-item__head">
            <span class="task-item__platform">{{ PLATFORM_NAMES[task.platform] }}</span>
            <span class="task-item__title">{{ task.title }}</span>
            <span class="task-item__status" :class="`task-status--${task.status}`">
              {{ taskStatusText(task.status) }}
            </span>
            <button
              v-if="task.status === 'pending' || task.status === 'running'"
              class="btn btn--small task-item__cancel"
              @click="handleCancelTask(task.taskId)"
            >取消</button>
          </div>
          <ProgressBar :progress="task.progress" :status="progressStatus(task.status)" />
          <div v-if="task.error" class="task-item__error">{{ task.error }}</div>
          <div v-else-if="task.videoUrl && task.status === 'completed'" class="task-item__url">
            {{ task.videoUrl }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.auto-publish-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.compliance-notice {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 8px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-warning, #e6a23c);
  border-radius: 6px;
  color: var(--color-warning, #e6a23c);
  font-size: 12px;
  text-align: center;
}

.view-header {
  margin-bottom: 4px;
}

.view-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 4px;
}

.view-desc {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin: 0;
}

.form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 12px;

  .section-header & {
    margin: 0;
  }
}

.platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.platform-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;

  &:hover {
    border-color: var(--color-border-strong);
  }

  &--active {
    border-color: var(--color-success);
  }

  &__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  &__name {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  &__status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--color-bg-elevated);
    color: var(--color-text-tertiary);
  }

  &__actions {
    display: flex;
    gap: 6px;
  }
}

.status {
  &--logged-in {
    color: var(--color-success);
    background: var(--color-accent-soft);
  }
  &--expired {
    color: var(--color-warning, #e6a23c);
    background: var(--color-bg-elevated);
  }
  &--logged-out {
    color: var(--color-text-tertiary);
    background: var(--color-bg-elevated);
  }
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  &--inline {
    gap: 16px;
    flex-wrap: wrap;
  }
}

.form-label {
  width: 80px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.form-input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;

  &:focus {
    border-color: var(--color-accent);
  }

  &--narrow {
    max-width: 220px;
  }
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.form-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 10px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  line-height: 1.6;

  &:focus {
    border-color: var(--color-accent);
  }

  &--small {
    min-height: 56px;
  }
}

.form-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.form-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;

  input {
    cursor: pointer;
  }
}

.btn--small {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
}

.action-bar {
  display: flex;
  gap: 8px;
}

.empty-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  padding: 8px 0;
}

.error-msg {
  font-size: 12px;
  color: var(--color-error);
  padding: 6px 0;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task-item {
  padding: 10px 12px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__platform {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-accent);
    flex-shrink: 0;
  }

  &__title {
    flex: 1;
    font-size: 12px;
    color: var(--color-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  &__cancel {
    margin-left: 4px;
  }

  &__error {
    font-size: 11px;
    color: var(--color-error);
  }

  &__url {
    font-size: 11px;
    color: var(--color-success);
    font-family: monospace;
    word-break: break-all;
  }
}

.task-status {
  &--pending {
    color: var(--color-text-tertiary);
    background: var(--color-bg-elevated);
  }
  &--running {
    color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  &--completed {
    color: var(--color-success);
    background: var(--color-accent-soft);
  }
  &--failed {
    color: var(--color-error);
    background: var(--color-bg-elevated);
  }
  &--cancelled {
    color: var(--color-text-tertiary);
    background: var(--color-bg-elevated);
  }
  &--paused {
    color: var(--color-warning, #e6a23c);
    background: var(--color-bg-elevated);
  }
}
</style>
