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
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import {
  publishQueue,
  authStore,
  adapterFactory,
  PLATFORM_NAMES,
} from '../services/auto-publish';
import type {
  PublishPlatform,
  PublishParams,
  AccountInfo,
} from '../services/auto-publish';
import { logger } from '../utils/logger';

/** 支持的平台集合(用于入参校验) */
const SUPPORTED_PLATFORMS: PublishPlatform[] = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili'];

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
   * 列出所有平台账号状态(基于本地登录态,不打开浏览器)
   * 返回: AccountInfo[]
   */
  safeHandle(ipc, 'auto-publish:listAccounts', () => {
    return authStore.listAccounts();
  });

  /**
   * 批量发布(多视频×多平台)
   * payload: { items: PublishParams[] }
   * 返回: { taskIds: string[] }
   */
  safeHandle(ipc, 'auto-publish:batchPublish', (_event, payload: unknown) => {
    const { items } = payload as { items: PublishParams[] };
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('auto-publish:batchPublish 入参无效:items 必须为非空数组');
    }
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
      const task = publishQueue.createTask(params);
      const id = publishQueue.enqueue(task);
      taskIds.push(id);
    }
    logger.info(
      `[IPC] auto-publish:batchPublish 已入队 ${taskIds.length}/${items.length} 个任务`,
    );
    return { taskIds };
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
}

/** 平台中文名映射(重新导出供 IPC 调用方使用) */
export { PLATFORM_NAMES };
