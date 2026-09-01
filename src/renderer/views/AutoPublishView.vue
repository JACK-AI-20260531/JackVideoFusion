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
 *   dialog:openFiles           - 多选视频文件
 *   dialog:openFile            - 选择封面文件
 *   task:progress              - 订阅任务进度推送
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import ProgressBar from './material-process/ProgressBar.vue';
import type { TaskStatus } from '@shared/types';

/** 支持的平台标识 */
type PublishPlatform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'bilibili' | 'shipinhao';

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
  /** 定时发布时间(ISO);仅在用户指定定时发布时存在 */
  scheduledAt?: string;
}

/** 平台中文名映射 */
const PLATFORM_NAMES: Record<PublishPlatform, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  shipinhao: '微信视频号',
};

/** 全部平台列表 */
const ALL_PLATFORMS: PublishPlatform[] = [
  'douyin',
  'kuaishou',
  'xiaohongshu',
  'bilibili',
  'shipinhao',
];

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
  shipinhao: { platform: 'shipinhao', loginStatus: 'logged-out' },
});
/** 正在登录的平台集合 */
const loggingPlatforms = ref<Set<PublishPlatform>>(new Set());
/** 正在检测登录的平台集合 */
const checkingPlatforms = ref<Set<PublishPlatform>>(new Set());

// ===== 发布表单 =====
/** 选中的视频文件路径列表(支持多选,空数组表示未选择) */
const videoPaths = ref<string[]>([]);
const title = ref('');
const description = ref('');
const tagsInput = ref('');
const coverPath = ref('');
/** 自动生成封面(未手动选封面时,高光帧+标题;PRD v1.6 FR-2) */
const autoCover = ref(true);
const scheduledAt = ref('');
/** 错峰间隔(分钟),同一视频多平台依次错开;0 = 关闭(PRD 默认 10) */
const staggerMin = ref(10);
const selectedPlatforms = ref<PublishPlatform[]>([]);

// ===== 任务列表 =====
const publishTasks = ref<PublishTaskView[]>([]);
const submitting = ref(false);
const error = ref<string | null>(null);

// ===== 计算属性 =====
/** 是否可添加到队列:至少一个视频 + 标题 + 至少一个平台 + 未在提交 */
const canSubmit = computed(
  () =>
    videoPaths.value.length > 0 &&
    title.value.trim().length > 0 &&
    selectedPlatforms.value.length > 0 &&
    !submitting.value,
);

/**
 * 从文件路径中提取文件名(含扩展名)
 * @param fullPath 完整路径
 * @returns 文件名,如 "demo.mp4"
 */
function basename(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * 为批量发布的每个视频生成展示标题
 * 单视频直接使用原标题;多视频在原标题后追加序号以区分。
 * @param baseTitle 用户输入的基础标题
 * @param index 当前视频索引(从 0 开始)
 * @param total 视频总数
 * @returns 该视频对应的标题
 */
function buildTaskTitle(baseTitle: string, index: number, total: number): string {
  if (total <= 1) return baseTitle;
  return `${baseTitle} (${index + 1}/${total})`;
}

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

/**
 * 格式化定时发布时间(本地时间 HH:mm)
 * @param scheduledAt ISO 时间字符串
 * @returns 形如 "06-01 12:30" 的本地可读文本
 */
function formatScheduled(scheduledAt?: string): string {
  if (!scheduledAt) return '';
  const d = new Date(scheduledAt);
  if (isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
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

  // 加载持久化的定时任务条目
  try {
    await loadSchedules();
  } catch {
    // 降级:保持空列表
  }

  // 加载发布数据回收记录
  try {
    await loadAnalytics();
  } catch {
    // 降级:保持空映射
  }

  // 加载数据看板与五维权重(数据飞轮)
  try {
    await loadDashboard();
  } catch {
    // 降级:保持空看板
  }
  try {
    await loadViralityWeights();
  } catch {
    // 降级:不展示权重面板
  }

  // 加载平台规格(半自动标识与标题上限提示)
  try {
    await loadSpecs();
  } catch {
    // 降级:不展示规格提示
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
 * 选择视频文件(支持多选;追加到已选列表,自动去重)
 */
async function handlePickVideo(): Promise<void> {
  const res = await getApi().invoke<
    { title?: string; filters?: { name: string; extensions: string[] }[] },
    string[]
  >('dialog:openFiles', {
    title: '选择视频文件(可多选)',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv'] }],
  });
  if (res.ok && res.data && res.data.length > 0) {
    // 去重追加
    const existing = new Set(videoPaths.value);
    for (const p of res.data) {
      if (!existing.has(p)) {
        videoPaths.value.push(p);
      }
    }
  }
}

/**
 * 移除指定索引的视频
 * @param index 视频在列表中的索引
 */
function handleRemoveVideo(index: number): void {
  if (index < 0 || index >= videoPaths.value.length) return;
  videoPaths.value.splice(index, 1);
}

/**
 * 清空所有已选视频
 */
function handleClearVideos(): void {
  videoPaths.value = [];
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
 * 添加发布任务到队列
 * 笛卡尔积:(每个视频 × 每个平台) 生成一项发布任务。
 * 单视频单平台走 publish 通道;否则走 batchPublish。
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

    const videos = videoPaths.value;
    const totalVideos = videos.length;
    const baseTitle = title.value;

    // 智能封面:未手动选封面且开启时,逐视频生成(单视频失败降级为无封面,不阻断入队)
    const coverByVideo = new Map<string, string | undefined>();
    if (autoCover.value && !coverPath.value) {
      for (const video of videos) {
        try {
          const res = await getApi().invoke<
            { videoPath: string; coverText?: string; outputDir?: string },
            { coverPath: string }
          >('auto-publish:generateCover', {
            videoPath: video,
            coverText: baseTitle,
          });
          if (res.ok && res.data?.coverPath) {
            coverByVideo.set(video, res.data.coverPath);
          }
        } catch {
          // 生成失败降级:该视频无封面
        }
      }
    }

    // 笛卡尔积:video × platform
    const items: PublishParams[] = [];
    for (let vi = 0; vi < totalVideos; vi++) {
      const taskTitle = buildTaskTitle(baseTitle, vi, totalVideos);
      for (const platform of selectedPlatforms.value) {
        items.push({
          platform,
          videoPath: videos[vi],
          title: taskTitle,
          description: description.value || undefined,
          tags: tags.length > 0 ? tags : undefined,
          coverPath: (coverByVideo.get(videos[vi]) ?? coverPath.value) || undefined,
          scheduledAt: scheduled,
        });
      }
    }

    // 单项用 publish,多项用 batchPublish(带错峰间隔)
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
      const staggerIntervalMs = staggerMin.value > 0 ? staggerMin.value * 60_000 : undefined;
      const res = await getApi().invoke<
        { items: PublishParams[]; staggerIntervalMs?: number },
        { taskIds: string[] }
      >('auto-publish:batchPublish', { items, staggerIntervalMs });
      if (res.ok && res.data) {
        taskIds = res.data.taskIds;
      } else {
        error.value = res.error ?? '批量入队失败';
      }
    }

    // 加入本地任务列表(按 taskIds 顺序与 items 一一对应,展示错峰后的实际时间)
    const now = new Date().toISOString();
    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i];
      const item = items[i];
      publishTasks.value.unshift({
        taskId: id,
        platform: item.platform,
        title: item.title,
        status: 'pending',
        progress: 0,
        createdAt: now,
        scheduledAt: item.scheduledAt,
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
 * 重试失败的发布任务
 * @param taskId 任务 ID
 */
async function handleRetryTask(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { retried: boolean }>('auto-publish:retry', {
    taskId,
  });
}

/**
 * 暂停发布任务(017 AC)
 * @param taskId 任务 ID
 */
async function handlePauseTask(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { paused: boolean }>('auto-publish:pause', {
    taskId,
  });
}

/**
 * 恢复被暂停的发布任务(017 AC)
 * @param taskId 任务 ID
 */
async function handleResumeTask(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { resumed: boolean }>('auto-publish:resume', {
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

// ===== 定时任务(PRD FR-5:持久化定时) =====
/** 定时条目(与主进程 ScheduledEntry 结构一致) */
interface ScheduledEntryView {
  taskId: string;
  platform: PublishPlatform;
  title: string;
  scheduledAt: string;
  createdAt: string;
  status: 'pending' | 'firing' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

/** 定时任务列表 */
const schedules = ref<ScheduledEntryView[]>([]);
/** 定时任务是否加载中 */
const schedulesLoading = ref(false);

/**
 * 定时条目状态中文文本
 * @param status 定时条目状态
 */
function scheduleStatusText(status: ScheduledEntryView['status']): string {
  switch (status) {
    case 'pending':
      return '待发布';
    case 'firing':
      return '发布中';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知';
  }
}

/**
 * 判断条目是否为"错过定时发布时间"
 * @param entry 定时条目
 */
function isMissed(entry: ScheduledEntryView): boolean {
  return entry.status === 'failed' && !!entry.error && entry.error.includes('错过');
}

/**
 * 判断条目是否为终态(可移除)
 * @param entry 定时条目
 */
function isTerminalSchedule(entry: ScheduledEntryView): boolean {
  return (
    entry.status === 'done' ||
    entry.status === 'failed' ||
    entry.status === 'cancelled'
  );
}

/**
 * 加载定时任务列表(持久化,按定时时间升序)
 */
async function loadSchedules(): Promise<void> {
  schedulesLoading.value = true;
  try {
    const res = await getApi().invoke<unknown, ScheduledEntryView[]>('auto-publish:listSchedules');
    if (res.ok && res.data) {
      schedules.value = res.data;
    }
  } finally {
    schedulesLoading.value = false;
  }
}

/**
 * 取消待发布的定时任务
 * @param taskId 任务 ID
 */
async function handleCancelSchedule(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { cancelled: string }>('auto-publish:cancel', {
    taskId,
  });
  await loadSchedules();
}

/**
 * 错过定时发布的任务一键立即执行(复用 retry)
 * @param taskId 任务 ID
 */
async function handleRetrySchedule(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { retried: boolean }>('auto-publish:retry', {
    taskId,
  });
  await loadSchedules();
}

/**
 * 移除终态定时条目(清理历史记录)
 * @param taskId 任务 ID
 */
async function handleRemoveSchedule(taskId: string): Promise<void> {
  await getApi().invoke<{ taskId: string }, { removed: string }>('auto-publish:removeSchedule', {
    taskId,
  });
  await loadSchedules();
}

// ===== 发布数据回收(PRD v1.6 FR-1) =====
/** 分析记录(与主进程 AnalyticsRecord 结构一致) */
interface AnalyticsRecordView {
  videoUrl: string;
  taskId: string;
  platform: PublishPlatform;
  title: string;
  history: { plays?: number; likes?: number; comments?: number; collectedAt: string }[];
}

/** taskId → 分析记录(每任务取最新绑定) */
const analyticsMap = ref<Record<string, AnalyticsRecordView>>({});
/** URL 绑定草稿 */
const bindUrlDrafts = ref<Record<string, string>>({});
/** 采集中状态 */
const statsBusy = ref<Record<string, boolean>>({});

/**
 * 格式化数量:过万显示" x.x万",否则原样
 * @param n 数量(可空)
 */
function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/**
 * 取记录的最近一次采集
 * @param record 分析记录
 */
function latestStatsOf(record: AnalyticsRecordView) {
  return record.history.length > 0 ? record.history[record.history.length - 1] : null;
}

/**
 * 加载分析记录(构建 taskId → record 映射)
 */
async function loadAnalytics(): Promise<void> {
  const res = await getApi().invoke<unknown, AnalyticsRecordView[]>('auto-publish:listAnalytics');
  if (res.ok && res.data) {
    const map: Record<string, AnalyticsRecordView> = {};
    for (const record of res.data) {
      map[record.taskId] = record;
    }
    analyticsMap.value = map;
  }
}

/**
 * 绑定视频链接(发布后手动粘贴,用于追踪数据)
 * @param task 发布任务视图
 */
async function handleBindUrl(task: PublishTaskView): Promise<void> {
  const draft = (bindUrlDrafts.value[task.taskId] ?? '').trim();
  if (draft.length === 0) return;
  const res = await getApi().invoke<
    { taskId: string; platform: PublishPlatform; title: string; videoUrl: string },
    AnalyticsRecordView
  >('auto-publish:bindVideoUrl', {
    taskId: task.taskId,
    platform: task.platform,
    title: task.title,
    videoUrl: draft,
  });
  if (res.ok) {
    bindUrlDrafts.value[task.taskId] = '';
    await loadAnalytics();
    await loadDashboard();
  }
}

/**
 * 手动刷新采集数据(复用已登录会话,单次单任务)
 * @param taskId 任务 ID
 */
async function handleFetchStats(taskId: string): Promise<void> {
  if (statsBusy.value[taskId]) return;
  statsBusy.value = { ...statsBusy.value, [taskId]: true };
  try {
    const res = await getApi().invoke<{ taskId: string }, AnalyticsRecordView>(
      'auto-publish:fetchStats',
      { taskId },
    );
    if (res.ok && res.data) {
      analyticsMap.value = { ...analyticsMap.value, [taskId]: res.data };
      await loadDashboard();
    }
  } finally {
    statsBusy.value = { ...statsBusy.value, [taskId]: false };
  }
}

// ===== 数据看板(PRD v1.7 FR-2/FR-3) =====
/** 看板单条明细(与主进程 DashboardItem 结构一致) */
interface DashboardItemView {
  videoUrl: string;
  taskId: string;
  title: string;
  platform: PublishPlatform;
  plays?: number;
  likes?: number;
  comments?: number;
  engagementRate?: number;
  playsDelta24h?: number;
  sampleCount: number;
  firstCollectedAt?: string;
  latestCollectedAt?: string;
}

/** 看板聚合摘要(与主进程 DashboardSummary 结构一致) */
interface DashboardView {
  totalVideos: number;
  totalPlays: number;
  totalLikes: number;
  totalComments: number;
  published7d: number;
  published30d: number;
  items: DashboardItemView[];
}

/** 五维权重(与主进程 ViralityWeights 结构一致) */
interface ViralityWeightsView {
  hook: number;
  emotion: number;
  topic: number;
  retention: number;
  titleability: number;
}

const dashboard = ref<DashboardView | null>(null);
const weightsView = ref<ViralityWeightsView | null>(null);
const calibrating = ref(false);

/** 权重展示:五维键名 → 中文名 */
const WEIGHT_LABELS: Record<keyof ViralityWeightsView, string> = {
  hook: '钩子',
  emotion: '情绪',
  topic: '话题',
  retention: '完播',
  titleability: '标题',
};

/**
 * 加载看板聚合数据
 */
async function loadDashboard(): Promise<void> {
  const res = await getApi().invoke<unknown, DashboardView>('auto-publish:dashboard');
  if (res.ok && res.data) {
    dashboard.value = res.data;
  }
}

/**
 * 加载当前生效的五维权重(校准优先,回退默认)
 */
async function loadViralityWeights(): Promise<void> {
  const res = await getApi().invoke<unknown, { weights: ViralityWeightsView }>(
    'ai-slice:viralityWeights',
  );
  if (res.ok && res.data) {
    weightsView.value = res.data.weights;
  }
}

/**
 * 执行权重自学习校准(评分历史 × 发布数据)
 */
async function handleCalibrate(): Promise<void> {
  if (calibrating.value) return;
  calibrating.value = true;
  try {
    const res = await getApi().invoke<unknown, { learned: boolean; sampleCount: number }>(
      'ai-slice:calibrateWeights',
    );
    if (res.ok) {
      error.value = res.data?.learned
        ? null
        : `样本不足(需 ≥20,当前 ${res.data?.sampleCount ?? 0}),暂无法校准`;
      await loadViralityWeights();
    }
  } finally {
    calibrating.value = false;
  }
}

/**
 * 重置五维权重为默认值
 */
async function handleResetWeights(): Promise<void> {
  const res = await getApi().invoke<unknown, { reset: boolean }>(
    'ai-slice:resetViralityWeights',
  );
  if (res.ok) {
    await loadViralityWeights();
  }
}

/**
 * 格式化互动率/权重为百分比文本
 * @param v 比例值(0-1,可空)
 */
function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return `${(v * 100).toFixed(1)}%`;
}

// ===== 平台规格(PRD v1.7 FR-4) =====
/** 平台发布规格视图(与主进程 PublishSpec 结构一致) */
interface PublishSpecView {
  autoPublish: boolean;
  titleLimit: number;
  tagLimit: number;
  coverAspect: string;
}

/** 各平台规格(autoPublish=false 为半自动降级平台) */
const specs = ref<Record<string, PublishSpecView> | null>(null);

/** 已选平台的规格提示(标题上限/话题上限) */
const titleLimitHint = computed(() => {
  if (!specs.value || selectedPlatforms.value.length === 0) return '';
  return selectedPlatforms.value
    .map((p) => {
      const s = specs.value?.[p];
      return s ? `${PLATFORM_NAMES[p]} 标题≤${s.titleLimit}字/话题≤${s.tagLimit}` : '';
    })
    .filter(Boolean)
    .join(';');
});

/**
 * 加载各平台发布规格
 */
async function loadSpecs(): Promise<void> {
  const res = await getApi().invoke<unknown, Record<string, PublishSpecView>>(
    'auto-publish:specs',
  );
  if (res.ok && res.data) {
    specs.value = res.data;
  }
}

// ===== CSV 批量导入(PRD v1.6 FR-3) =====
/** CSV 预览(解析+校验结果,未入队) */
interface CsvPreviewView {
  total: number;
  validCount: number;
  preview: { videoPath: string; platform: PublishPlatform; title: string; scheduledAt?: string }[];
  errors: { line: number; reason: string }[];
}

const csvPreview = ref<CsvPreviewView | null>(null);
const csvFilePath = ref('');
const importing = ref(false);

/**
 * 下载 CSV 模板
 */
async function downloadCsvTemplate(): Promise<void> {
  const res = await getApi().invoke<unknown, string>('auto-publish:csvTemplate');
  if (res.ok && res.data) {
    const blob = new Blob(['\uFEFF' + res.data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'publish-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

/**
 * 选择 CSV 文件并解析预览(校验失败行红标,合法行待确认入队)
 */
async function handlePickCsv(): Promise<void> {
  error.value = null;
  const res = await getApi().invoke<{ title?: string; filters?: { name: string; extensions: string[] }[] }, string[]>(
    'dialog:openFile',
    { title: '选择任务清单 CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] },
  );
  if (!(res.ok && res.data && res.data.length > 0)) return;
  csvFilePath.value = res.data[0];
  const preview = await getApi().invoke<{ filePath: string }, CsvPreviewView>(
    'auto-publish:previewCsv',
    { filePath: csvFilePath.value },
  );
  if (preview.ok && preview.data) {
    csvPreview.value = preview.data;
  } else {
    error.value = preview.error ?? '清单解析失败';
  }
}

/**
 * 确认导入合法行(走 batchPublish 错峰通道)
 */
async function handleImportCsv(): Promise<void> {
  if (importing.value || !csvPreview.value) return;
  importing.value = true;
  try {
    const res = await getApi().invoke<
      { filePath: string; staggerIntervalMs?: number },
      { taskIds: string[]; tasks: { taskId: string; platform: PublishPlatform; title: string; scheduledAt?: string }[]; errors: { line: number; reason: string }[] }
    >('auto-publish:importCsv', {
      filePath: csvFilePath.value,
      staggerIntervalMs: staggerMin.value > 0 ? staggerMin.value * 60_000 : undefined,
    });
    if (res.ok && res.data) {
      const now = new Date().toISOString();
      for (const t of res.data.tasks) {
        publishTasks.value.unshift({
          taskId: t.taskId,
          platform: t.platform,
          title: t.title,
          status: 'pending',
          progress: 0,
          createdAt: now,
          scheduledAt: t.scheduledAt,
        });
      }
      await loadSchedules();
      csvPreview.value = null;
    } else {
      error.value = res.error ?? '导入失败';
    }
  } finally {
    importing.value = false;
  }
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
      <div class="form-row form-row--block">
        <label class="form-label">视频文件</label>
        <div class="form-input-group form-input-group--column">
          <div class="video-toolbar">
            <button class="btn btn--small btn--primary" @click="handlePickVideo">
              + 添加视频
            </button>
            <button
              v-if="videoPaths.length > 0"
              class="btn btn--small"
              @click="handleClearVideos"
            >清空</button>
            <span class="form-hint">已选 {{ videoPaths.length }} 个视频</span>
          </div>
          <div v-if="videoPaths.length === 0" class="video-empty">
            暂未选择视频,点击「添加视频」可多选
          </div>
          <ul v-else class="video-list">
            <li v-for="(path, idx) in videoPaths" :key="path" class="video-list__item">
              <span class="video-list__index">{{ idx + 1 }}.</span>
              <span class="video-list__name" :title="path">{{ basename(path) }}</span>
              <span class="video-list__path">{{ path }}</span>
              <button
                class="btn btn--small video-list__remove"
                @click="handleRemoveVideo(idx)"
              >移除</button>
            </li>
          </ul>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">标题</label>
        <input v-model="title" class="form-input" placeholder="请输入视频标题" />
        <span v-if="titleLimitHint" class="form-hint">规格预检:{{ titleLimitHint }}</span>
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
      <div class="form-row form-row--inline">
        <label class="form-checkbox">
          <input v-model="autoCover" type="checkbox" /> 自动生成封面(高光帧 + 标题,未手动选封面时生效)
        </label>
      </div>
      <div class="form-row">
        <label class="form-label">定时发布</label>
        <input v-model="scheduledAt" type="datetime-local" class="form-input form-input--narrow" />
        <span class="form-hint">留空则立即发布(部分平台不支持定时)</span>
      </div>
      <div class="form-row">
        <label class="form-label">错峰间隔(分钟)</label>
        <input
          v-model.number="staggerMin"
          type="number"
          min="0"
          step="1"
          class="form-input form-input--narrow"
        />
        <span class="form-hint">同一视频多平台发布时间依次错开,0 = 关闭</span>
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
          <span
            v-if="specs && specs[platform] && !specs[platform].autoPublish"
            class="platform-badge"
            title="该平台暂不稳定,将生成发布物料包并打开上传页,由您手动完成发布"
          >半自动</span>
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
        <div class="result-section__actions">
          <button class="btn btn--small" @click="handlePickCsv">导入清单</button>
          <button class="btn btn--small" @click="downloadCsvTemplate">下载模板</button>
          <button class="btn btn--small" @click="handleClearFinished">清理已完成</button>
        </div>
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
            <span v-if="task.scheduledAt && task.status === 'pending'" class="task-item__sched">
              ⏰ {{ formatScheduled(task.scheduledAt) }} 定时发布
            </span>
            <button
              v-if="task.status === 'pending' || task.status === 'running'"
              class="btn btn--small task-item__pause"
              @click="handlePauseTask(task.taskId)"
            >暂停</button>
            <button
              v-if="task.status === 'pending' || task.status === 'running' || task.status === 'paused'"
              class="btn btn--small task-item__cancel"
              @click="handleCancelTask(task.taskId)"
            >取消</button>
            <button
              v-if="task.status === 'paused'"
              class="btn btn--small task-item__resume"
              @click="handleResumeTask(task.taskId)"
            >恢复</button>
            <button
              v-else-if="task.status === 'failed' || task.status === 'cancelled'"
              class="btn btn--small task-item__retry"
              @click="handleRetryTask(task.taskId)"
            >重试</button>
          </div>
          <ProgressBar :progress="task.progress" :status="progressStatus(task.status)" />
          <!-- 发布数据回收(PRD v1.6 FR-1) -->
          <div v-if="task.status === 'completed'" class="task-stats">
            <template v-if="analyticsMap[task.taskId]">
              <span class="task-stats__item">🔥 {{ formatCount(latestStatsOf(analyticsMap[task.taskId])?.plays) }}</span>
              <span class="task-stats__item">👍 {{ formatCount(latestStatsOf(analyticsMap[task.taskId])?.likes) }}</span>
              <span class="task-stats__item">💬 {{ formatCount(latestStatsOf(analyticsMap[task.taskId])?.comments) }}</span>
              <span class="sched-time">
                🕒 {{ formatScheduled(latestStatsOf(analyticsMap[task.taskId])?.collectedAt) }}
              </span>
              <button
                class="btn btn--small"
                :disabled="statsBusy[task.taskId]"
                @click="handleFetchStats(task.taskId)"
              >
                {{ statsBusy[task.taskId] ? '采集中...' : '刷新数据' }}
              </button>
            </template>
            <template v-else>
              <input
                v-model="bindUrlDrafts[task.taskId]"
                class="form-input task-stats__input"
                placeholder="粘贴视频链接以追踪数据(可选)"
              />
              <button class="btn btn--small" @click="handleBindUrl(task)">绑定</button>
            </template>
          </div>
          <div v-if="task.error" class="task-item__error">{{ task.error }}</div>
          <div v-else-if="task.videoUrl && task.status === 'completed'" class="task-item__url">
            {{ task.videoUrl }}
          </div>
        </div>
      </div>
    </section>

    <!-- CSV 清单预览(PRD v1.6 FR-3:校验红绿标注,确认后导入合法行) -->
    <section v-if="csvPreview" class="form-section csv-preview">
      <div class="section-header">
        <h3 class="section-title">
          清单预览:共 {{ csvPreview.total }} 行,合法 {{ csvPreview.validCount }} 行,失败
          {{ csvPreview.errors.length }} 行
        </h3>
        <div class="result-section__actions">
          <button class="btn btn--small btn--primary" :disabled="importing || csvPreview.validCount === 0" @click="handleImportCsv">
            {{ importing ? '导入中...' : '导入合法行' }}
          </button>
          <button class="btn btn--small" @click="csvPreview = null">取消</button>
        </div>
      </div>
      <div class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th class="result-table__th">平台</th>
              <th class="result-table__th">标题</th>
              <th class="result-table__th">定时</th>
              <th class="result-table__th">视频</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in csvPreview.preview" :key="i">
              <td class="result-table__td">{{ PLATFORM_NAMES[row.platform] }}</td>
              <td class="result-table__td">{{ row.title }}</td>
              <td class="result-table__td">{{ row.scheduledAt ? formatScheduled(row.scheduledAt) : '立即' }}</td>
              <td class="result-table__td result-table__td--path">{{ row.videoPath }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul v-if="csvPreview.errors.length" class="csv-errors">
        <li v-for="e in csvPreview.errors" :key="e.line" class="csv-errors__item">
          第 {{ e.line }} 行:{{ e.reason }}
        </li>
      </ul>
    </section>

    <!-- 数据看板(PRD v1.7 FR-2/FR-3:汇总 + 权重自学习 + 单条明细) -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">数据看板</h3>
        <div class="result-section__actions">
          <button
            class="btn btn--small btn--primary"
            :disabled="calibrating"
            title="用已发布视频的真实互动数据校准爆款评分权重"
            @click="handleCalibrate"
          >
            {{ calibrating ? '校准中...' : '校准评分权重' }}
          </button>
          <button class="btn btn--small" @click="handleResetWeights">重置权重</button>
          <button class="btn btn--small" @click="loadDashboard">刷新</button>
        </div>
      </div>

      <div v-if="dashboard" class="dash-cards">
        <div class="dash-card">
          <span class="dash-card__num">{{ formatCount(dashboard.totalPlays) }}</span>
          <span class="dash-card__label">总播放</span>
        </div>
        <div class="dash-card">
          <span class="dash-card__num">{{ formatCount(dashboard.totalLikes) }}</span>
          <span class="dash-card__label">总点赞</span>
        </div>
        <div class="dash-card">
          <span class="dash-card__num">{{ formatCount(dashboard.totalComments) }}</span>
          <span class="dash-card__label">总评论</span>
        </div>
        <div class="dash-card">
          <span class="dash-card__num">{{ dashboard.published7d }}</span>
          <span class="dash-card__label">近 7 天发布</span>
        </div>
        <div class="dash-card">
          <span class="dash-card__num">{{ dashboard.published30d }}</span>
          <span class="dash-card__label">近 30 天发布</span>
        </div>
      </div>

      <div v-if="weightsView" class="dash-weights">
        <span class="dash-weights__title">评分权重(自学习):</span>
        <span v-for="(label, key) in WEIGHT_LABELS" :key="key" class="dash-weights__item">
          {{ label }} {{ formatPercent(weightsView[key]) }}
        </span>
      </div>

      <div v-if="!dashboard || dashboard.items.length === 0" class="empty-hint">
        发布成功并绑定视频链接后,这里将展示播放/互动数据趋势
      </div>
      <div v-else class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th class="result-table__th">标题</th>
              <th class="result-table__th">平台</th>
              <th class="result-table__th">播放</th>
              <th class="result-table__th">24h 增量</th>
              <th class="result-table__th">点赞</th>
              <th class="result-table__th">评论</th>
              <th class="result-table__th">互动率</th>
              <th class="result-table__th">采集次数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in dashboard.items" :key="item.videoUrl">
              <td class="result-table__td" :title="item.title">{{ item.title || '(无标题)' }}</td>
              <td class="result-table__td">{{ PLATFORM_NAMES[item.platform] }}</td>
              <td class="result-table__td">{{ formatCount(item.plays) }}</td>
              <td class="result-table__td">
                {{ item.playsDelta24h === undefined ? '-' : `+${formatCount(item.playsDelta24h)}` }}
              </td>
              <td class="result-table__td">{{ formatCount(item.likes) }}</td>
              <td class="result-table__td">{{ formatCount(item.comments) }}</td>
              <td class="result-table__td">{{ formatPercent(item.engagementRate) }}</td>
              <td class="result-table__td">{{ item.sampleCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 定时任务区(PRD FR-5:持久化定时,重启不丢,错过可补发) -->
    <section class="form-section">
      <div class="section-header">
        <h3 class="section-title">定时任务</h3>
        <button class="btn btn--small" :disabled="schedulesLoading" @click="loadSchedules">
          {{ schedulesLoading ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div v-if="schedules.length === 0" class="empty-hint">暂无定时任务</div>
      <div v-else class="task-list">
        <div v-for="s in schedules" :key="s.taskId" class="task-item">
          <div class="task-item__head">
            <span class="task-item__platform">{{ PLATFORM_NAMES[s.platform] }}</span>
            <span class="task-item__title">{{ s.title }}</span>
            <span class="sched-time">⏰ {{ formatScheduled(s.scheduledAt) }}</span>
            <span class="sched-status" :class="`sched-status--${s.status}`">
              {{ isMissed(s) ? '错过发布' : scheduleStatusText(s.status) }}
            </span>
            <button
              v-if="s.status === 'pending'"
              class="btn btn--small"
              @click="handleCancelSchedule(s.taskId)"
            >取消</button>
            <button
              v-if="isMissed(s)"
              class="btn btn--small sched-retry"
              title="以原参数立即发布"
              @click="handleRetrySchedule(s.taskId)"
            >立即执行</button>
            <button
              v-if="isTerminalSchedule(s)"
              class="btn btn--small"
              @click="handleRemoveSchedule(s.taskId)"
            >移除</button>
          </div>
          <div v-if="s.error" class="task-item__error">{{ s.error }}</div>
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
    color: var(--color-warning);
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

  &--block {
    align-items: flex-start;
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

  &--column {
    flex-direction: column;
    align-items: stretch;
  }
}

.video-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.video-empty {
  padding: 12px;
  background: var(--color-bg-sunken);
  border: 1px dashed var(--color-border-default);
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  text-align: center;
}

.video-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;

  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    font-size: 12px;
  }

  &__index {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
    min-width: 18px;
  }

  &__name {
    color: var(--color-text-primary);
    font-weight: 500;
    flex-shrink: 0;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__path {
    flex: 1;
    color: var(--color-text-tertiary);
    font-family: monospace;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__remove {
    flex-shrink: 0;
  }
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
    color: var(--color-warning);
    background: var(--color-bg-elevated);
  }
}

.sched-time {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.sched-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;

  &--pending {
    color: var(--color-warning);
    background: var(--color-bg-elevated);
  }
  &--firing {
    color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  &--done {
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
}

.sched-retry {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.task-stats {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 12px;

  &__item {
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  &__input {
    max-width: 360px;
    height: 26px;
    font-size: 11px;
  }
}

.csv-preview {
  border-color: var(--color-accent);
}

.csv-errors {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-error);

  &__item {
    line-height: 20px;
  }
}

// 平台半自动徽章(PRD v1.7 FR-4)
.platform-badge {
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--color-accent);
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  color: var(--color-accent);
}

// 数据看板(PRD v1.7 FR-2)
.dash-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.dash-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 96px;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary, transparent);

  &__num {
    font-size: 18px;
    font-weight: 600;
  }

  &__label {
    font-size: 11px;
    color: var(--color-text-secondary);
  }
}

.dash-weights {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 12px;

  &__title {
    color: var(--color-text-secondary);
  }

  &__item {
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    white-space: nowrap;
  }
}
</style>
