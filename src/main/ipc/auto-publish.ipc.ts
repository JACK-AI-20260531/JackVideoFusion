/**
 * 自动发布 IPC 注册
 *
 * 职责:将 auto-publish 服务的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   auto-publish:login       - 打开浏览器扫码登录指定平台
 *   auto-publish:checkLogin  - 检查指定平台登录状态(基于持久化 userDataDir)
 *   auto-publish:logout      - 退出指定平台登录(清除登录态)
 *   auto-publish:publish     - 发布视频(入队 task-queue,类型 'auto-publish',串行执行)
 *   auto-publish:cancel      - 取消发布任务
 *   auto-publish:listAccounts- 列出所有平台账号状态
 *   auto-publish:batchPublish- 批量发布(多视频×多平台)
 *   auto-publish:listSchedules  - 列出定时发布条目(持久化)
 *   auto-publish:removeSchedule - 移除定时条目(清理历史记录)
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import {
  publishQueue,
  authStore,
  scheduleStore,
  analyticsStore,
  applyStaggerToGroups,
  generateCover,
  readCsvText,
  parseCsvText,
  rowsToTasks,
  buildCsvTemplate,
  adapterFactory,
  PLATFORM_NAMES,
  AnalyticsScheduler,
  buildDashboard,
  validatePublishSpec,
  specBlockMessage,
  PUBLISH_SPECS,
} from '../services/auto-publish';
import type {
  PublishPlatform,
  PublishParams,
  AccountInfo,
} from '../services/auto-publish';
import { logger } from '../utils/logger';

/** 支持的平台集合(用于入参校验) */
const SUPPORTED_PLATFORMS: PublishPlatform[] = [
  'douyin',
  'kuaishou',
  'xiaohongshu',
  'bilibili',
  'shipinhao',
];

/**
 * 校验平台标识是否合法
 * @param platform 待校验值
 * @returns 是否为支持的平台
 */
function isValidPlatform(platform: unknown): platform is PublishPlatform {
  return (
    typeof platform === 'string' &&
    (SUPPORTED_PLATFORMS as string[]).includes(platform)
  );
}

/**
 * 发布平台规格预检(不合规阻断,PRD-v1.7 FR-4)
 * @param params 发布参数
 * @throws 阻断级不合规时抛错
 */
function assertSpecValid(params: PublishParams): void {
  const blockMsg = specBlockMessage(validatePublishSpec(params));
  if (blockMsg) {
    throw new Error(`发布预检未通过(${PLATFORM_NAMES[params.platform]}):${blockMsg}`);
  }
}

/**
 * 注册自动发布相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 扫码登录指定平台
   * payload: { platform }
   * 返回: AccountInfo
   */
  safeHandle(ipc, 'auto-publish:login', async (_event, payload: unknown) => {
    const { platform } = payload as { platform: PublishPlatform };
    if (!isValidPlatform(platform)) {
      throw new Error('auto-publish:login 入参无效:platform 必须为支持的平台');
    }
    logger.info(`[IPC] auto-publish:login 平台=${platform} 启动扫码登录`);
    const adapter = adapterFactory(platform);
    const account: AccountInfo = await adapter.login();
    return account;
  });

  /**
   * 检查指定平台登录状态
   * payload: { platform }
   * 返回: AccountInfo(含精确登录状态)
   */
  safeHandle(ipc, 'auto-publish:checkLogin', async (_event, payload: unknown) => {
    const { platform } = payload as { platform: PublishPlatform };
    if (!isValidPlatform(platform)) {
      throw new Error('auto-publish:checkLogin 入参无效:platform 必须为支持的平台');
    }
    const adapter = adapterFactory(platform);
    const account: AccountInfo = await adapter.checkLogin();
    return account;
  });

  /**
   * 退出指定平台登录(清除持久化登录态)
   * payload: { platform }
   * 返回: { platform, loggedOut: true }
   */
  safeHandle(ipc, 'auto-publish:logout', async (_event, payload: unknown) => {
    const { platform } = payload as { platform: PublishPlatform };
    if (!isValidPlatform(platform)) {
      throw new Error('auto-publish:logout 入参无效:platform 必须为支持的平台');
    }
    const adapter = adapterFactory(platform);
    await adapter.logout();
    return { platform, loggedOut: true };
  });

  /**
   * 发布视频(入队 task-queue,串行执行)
   * payload: PublishParams
   * 返回: { taskId }
   */
  safeHandle(ipc, 'auto-publish:publish', (_event, payload: unknown) => {
    const params = payload as PublishParams;
    if (
      !params ||
      !isValidPlatform(params.platform) ||
      typeof params.videoPath !== 'string' ||
      params.videoPath.trim().length === 0 ||
      typeof params.title !== 'string' ||
      params.title.trim().length === 0
    ) {
      throw new Error(
        'auto-publish:publish 入参无效:platform/videoPath/title 必填且合法',
      );
    }
    // 平台规格预检(标题/标签约束,不合规阻断)
    assertSpecValid(params);
    const task = publishQueue.createTask(params);
    const taskId = publishQueue.enqueue(task);
    logger.info(`[IPC] auto-publish:publish 任务 ${taskId} 已入队`);
    return { taskId };
  });

  /**
   * 取消发布任务
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'auto-publish:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:cancel 入参缺失 taskId');
    }
    publishQueue.cancel(taskId);
    return { cancelled: taskId };
  });

  /**
   * 重试失败的发布任务
   * payload: { taskId }
   * 返回: { retried: boolean }
   */
  safeHandle(ipc, 'auto-publish:retry', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:retry 入参缺失 taskId');
    }
    const retried = publishQueue.retry(taskId);
    return { retried };
  });

  /**
   * 暂停发布任务(017 AC: 支持暂停)
   * payload: { taskId }
   * 返回: { paused: boolean }
   */
  safeHandle(ipc, 'auto-publish:pause', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:pause 入参缺失 taskId');
    }
    const paused = publishQueue.pause(taskId);
    return { paused };
  });

  /**
   * 恢复被暂停的发布任务(017 AC: 支持恢复)
   * payload: { taskId }
   * 返回: { resumed: boolean }
   */
  safeHandle(ipc, 'auto-publish:resume', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:resume 入参缺失 taskId');
    }
    const resumed = publishQueue.resume(taskId);
    return { resumed };
  });

  /**
   * 列出所有平台账号状态(基于本地登录态,不打开浏览器)
   * 返回: AccountInfo[]
   */
  safeHandle(ipc, 'auto-publish:listAccounts', () => {
    return authStore.listAccounts();
  });

  /**
   * 列出定时发布条目(PRD FR-5,按定时时间升序,含待发布/执行中/错过/已完成等)
   * 返回: ScheduledEntry[]
   */
  safeHandle(ipc, 'auto-publish:listSchedules', () => {
    return scheduleStore.list();
  });

  /**
   * 移除定时条目(仅从定时表清理,不影响任务本身;用于清理历史记录)
   * payload: { taskId }
   * 返回: { removed: taskId }
   */
  safeHandle(ipc, 'auto-publish:removeSchedule', (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:removeSchedule 入参缺失 taskId');
    }
    scheduleStore.remove(taskId);
    logger.info(`[IPC] auto-publish:removeSchedule 条目 ${taskId} 已移除`);
    return { removed: taskId };
  });

  /**
   * 批量发布(多视频×多平台)
   * payload: { items: PublishParams[], staggerIntervalMs?: number }
   *   - staggerIntervalMs > 0 时,同一视频的多个平台目标按该间隔错峰(PRD FR-6):
   *     基准定时时间为合法未来时间则以它为基准,否则以当前时间为基准(首个即刻发布)
   * 返回: { taskIds: string[] }
   */
  safeHandle(ipc, 'auto-publish:batchPublish', (_event, payload: unknown) => {
    const { items, staggerIntervalMs } = payload as {
      items: PublishParams[];
      staggerIntervalMs?: number;
    };
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('auto-publish:batchPublish 入参无效:items 必须为非空数组');
    }
    const intervalMs =
      typeof staggerIntervalMs === 'number' && Number.isFinite(staggerIntervalMs) && staggerIntervalMs > 0
        ? staggerIntervalMs
        : 0;

    // 按 videoPath 分组错峰(共享纯函数,原地回写 scheduledAt)
    applyStaggerToGroups(
      items.filter((p) => p && isValidPlatform(p.platform)),
      intervalMs,
      Date.now(),
    );

    const taskIds: string[] = [];
    for (const params of items) {
      if (
        !params ||
        !isValidPlatform(params.platform) ||
        typeof params.videoPath !== 'string' ||
        params.videoPath.trim().length === 0 ||
        typeof params.title !== 'string' ||
        params.title.trim().length === 0
      ) {
        logger.warn(
          `[IPC] auto-publish:batchPublish 跳过无效项: ${JSON.stringify(params)}`,
        );
        continue;
      }
      // 平台规格预检:不合规项跳过并记录
      const blockMsg = specBlockMessage(validatePublishSpec(params));
      if (blockMsg) {
        logger.warn(
          `[IPC] auto-publish:batchPublish 跳过不合规项(${PLATFORM_NAMES[params.platform]}): ${blockMsg}`,
        );
        continue;
      }
      const task = publishQueue.createTask(params);
      const id = publishQueue.enqueue(task);
      taskIds.push(id);
    }
    logger.info(
      `[IPC] auto-publish:batchPublish 已入队 ${taskIds.length}/${items.length} 个任务(stagger=${intervalMs}ms)`,
    );
    return { taskIds };
  });

  /**
   * 绑定视频链接(发布数据回收前置步骤,PRD v1.6 FR-1)
   * payload: { taskId, platform, title, videoUrl }
   * 返回: AnalyticsRecord
   */
  safeHandle(ipc, 'auto-publish:bindVideoUrl', (_event, payload: unknown) => {
    const { taskId, platform, title, videoUrl } = payload as {
      taskId: string;
      platform: PublishPlatform;
      title: string;
      videoUrl: string;
    };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:bindVideoUrl 入参缺失 taskId');
    }
    if (!isValidPlatform(platform)) {
      throw new Error('auto-publish:bindVideoUrl 入参无效:platform 必须为支持的平台');
    }
    if (!videoUrl || typeof videoUrl !== 'string' || !/^https?:\/\//.test(videoUrl.trim())) {
      throw new Error('auto-publish:bindVideoUrl 入参无效:videoUrl 必须为 http(s) 链接');
    }
    return analyticsStore.bind({
      taskId,
      platform,
      title: typeof title === 'string' ? title : '',
      videoUrl: videoUrl.trim(),
    });
  });

  /**
   * 列出全部分析记录
   * 返回: AnalyticsRecord[]
   */
  safeHandle(ipc, 'auto-publish:listAnalytics', () => {
    return analyticsStore.list();
  });

  /**
   * 采集视频数据(手动触发,复用已登录会话;PRD FR-1 风控约束)
   * payload: { taskId }
   * 返回: AnalyticsRecord(含最新采集)
   */
  safeHandle(ipc, 'auto-publish:fetchStats', async (_event, payload: unknown) => {
    const { taskId } = payload as { taskId: string };
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('auto-publish:fetchStats 入参缺失 taskId');
    }
    const records = analyticsStore.listByTask(taskId);
    if (records.length === 0) {
      throw new Error('该任务尚未绑定视频链接,请先绑定');
    }
    const record = records[0];
    const adapter = adapterFactory(record.platform);
    if (typeof adapter.fetchStats !== 'function') {
      throw new Error(`平台 ${record.platform} 暂不支持数据采集`);
    }
    const stats = await adapter.fetchStats(record.videoUrl);
    analyticsStore.appendStats(record.videoUrl, stats);
    logger.info(
      `[IPC] auto-publish:fetchStats 任务 ${taskId} 采集完成 plays=${stats.plays ?? '-'} likes=${stats.likes ?? '-'}`,
    );
    return analyticsStore.get(record.videoUrl);
  });

  /**
   * 生成智能封面(高光帧 + 文字叠加,PRD v1.6 FR-2)
   * payload: { videoPath, coverText?, outputDir? }
   * 返回: { coverPath }
   */
  safeHandle(ipc, 'auto-publish:generateCover', async (_event, payload: unknown) => {
    const { videoPath, coverText, outputDir } = payload as {
      videoPath: string;
      coverText?: string;
      outputDir?: string;
    };
    if (!videoPath || typeof videoPath !== 'string' || videoPath.trim().length === 0) {
      throw new Error('auto-publish:generateCover 入参无效:videoPath 必填');
    }
    const coverPath = await generateCover(videoPath, {
      coverText: typeof coverText === 'string' ? coverText : undefined,
      outputDir: typeof outputDir === 'string' && outputDir.trim().length > 0 ? outputDir : undefined,
    });
    return { coverPath };
  });

  /**
   * 预览 CSV 清单(解析+校验,不入队;PRD v1.6 FR-3)
   * payload: { filePath }
   * 返回: { total, validCount, preview, errors }
   */
  safeHandle(ipc, 'auto-publish:previewCsv', (_event, payload: unknown) => {
    const { filePath } = payload as { filePath: string };
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('auto-publish:previewCsv 入参缺失 filePath');
    }
    const result = rowsToTasks(parseCsvText(readCsvText(filePath)));
    return {
      total: result.total,
      validCount: result.rows.length,
      preview: result.rows.slice(0, 10),
      errors: result.errors,
    };
  });

  /**
   * 导入 CSV 清单(合法行入队,支持错峰;失败行已在预览阶段展示)
   * payload: { filePath, staggerIntervalMs? }
   * 返回: { taskIds, imported, total, errors }
   */
  safeHandle(ipc, 'auto-publish:importCsv', (_event, payload: unknown) => {
    const { filePath, staggerIntervalMs } = payload as {
      filePath: string;
      staggerIntervalMs?: number;
    };
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('auto-publish:importCsv 入参缺失 filePath');
    }
    const result = rowsToTasks(parseCsvText(readCsvText(filePath)));
    if (result.rows.length > 0) {
      applyStaggerToGroups(
        result.rows,
        typeof staggerIntervalMs === 'number' && staggerIntervalMs > 0 ? staggerIntervalMs : 0,
        Date.now(),
      );
    }
    const taskIds: string[] = [];
    const scheduledList: { taskId: string; platform: PublishPlatform; title: string; scheduledAt?: string }[] = [];
    for (const row of result.rows) {
      const task = publishQueue.createTask(row);
      taskIds.push(publishQueue.enqueue(task));
      scheduledList.push({
        taskId: task.id,
        platform: row.platform,
        title: row.title,
        scheduledAt: row.scheduledAt,
      });
    }
    logger.info(
      `[IPC] auto-publish:importCsv 导入 ${taskIds.length}/${result.total} 个任务(失败 ${result.errors.length} 行)`,
    );
    return { taskIds, imported: taskIds.length, total: result.total, errors: result.errors, tasks: scheduledList };
  });

  /**
   * 下载 CSV 模板文本
   * 返回: string
   */
  safeHandle(ipc, 'auto-publish:csvTemplate', () => {
    return buildCsvTemplate();
  });

  /**
   * 各平台发布规格与能力位(PRD-v1.7 FR-4,渲染层表单提示用)
   * 返回: Record<PublishPlatform, PublishSpec>
   */
  safeHandle(ipc, 'auto-publish:specs', () => {
    return PUBLISH_SPECS;
  });

  /**
   * 数据看板聚合(PRD-v1.7 FR-2:汇总卡片 + 单条明细)
   * 返回: DashboardSummary
   */
  safeHandle(ipc, 'auto-publish:dashboard', () => {
    return buildDashboard(analyticsStore.list());
  });

  // 应用启动时恢复重启前遗留的定时发布任务(基于 taskQueue 持久化的 auto-publish 任务)
  try {
    const restoredCount = publishQueue.restoreScheduled();
    if (restoredCount > 0) {
      logger.info(`[IPC] auto-publish 恢复定时任务 ${restoredCount} 个`);
    }
  } catch (err) {
    logger.warn(
      `[IPC] auto-publish 恢复定时任务失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 启动发布数据自动采集调度器(PRD-v1.7 FR-1:早期 6h/次,成熟期 24h/次)
  try {
    const scheduler = new AnalyticsScheduler({ store: analyticsStore, adapterFactory });
    scheduler.start();
    logger.info('[IPC] auto-publish 数据自动采集调度器已启动');
  } catch (err) {
    logger.warn(
      `[IPC] auto-publish 采集调度器启动失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 平台中文名映射(重新导出供 IPC 调用方使用) */
export { PLATFORM_NAMES };
