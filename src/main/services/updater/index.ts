/**
 * 自动更新服务
 *
 * 职责:封装 electron-updater 的检查/下载/安装流程,向渲染层推送进度事件。
 *       仅打包后的生产环境生效;开发环境空操作,避免 electron-updater 报错。
 *
 * 设计约定:
 *   - 依赖 electron-builder 的 publish 配置(provider: generic → Gitee Releases)
 *   - 通过注册 AutoUpdater 事件 + BrowserWindow.webContents.send('updater:progress') 推送进度
 *   - app.isPackaged=false(开发环境)时所有方法返回占位,不触发真实更新
 *   - 幂等:重复下载同一版本自动跳过
 */
import { app, BrowserWindow } from 'electron';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { logger } from '../../utils/logger';

// electron-updater 的动态导入(延迟加载,避免开发环境在非 Electron 上下文的报错)
let autoUpdaterInit: (() => Promise<typeof import('electron-updater').autoUpdater>) | null = null;

async function getAutoUpdater(): Promise<typeof import('electron-updater').autoUpdater | null> {
  if (!app.isPackaged) return null;
  if (!autoUpdaterInit) {
    autoUpdaterInit = async () => {
      const mod = await import('electron-updater');
      // win: true 强制走 NSIS 安装包更新
      return mod.autoUpdater;
    };
  }
  try {
    return await autoUpdaterInit();
  } catch (err) {
    logger.warn(`[Updater] electron-updater 加载失败:${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 向所有窗口推送更新事件 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/** 渲染层可读的更新状态标签 */
export type UpdateState =
  | 'disabled' // 非打包环境,更新不可用
  | 'idle' // 空闲
  | 'checking' // 检查中
  | 'checking-error' // 检查失败
  | 'no-update' // 无可用更新
  | 'available' // 发现新版本(未下载)
  | 'downloading' // 下载中
  | 'downloaded' // 下载完成,可安装
  | 'error'; // 更新过程出错

/** 渲染层进度载荷 */
export interface UpdaterProgressPayload {
  state: UpdateState;
  /** 当前版本 */
  currentVersion?: string;
  /** 新版本(available/downloading/downloaded 时存在) */
  newVersion?: string;
  /** 下载进度 0-100 */
  percent?: number;
  /** 已下载字节 */
  transferred?: number;
  /** 总字节 */
  total?: number;
  /** 人类可读的速度 */
  bytesPerSecond?: number;
  /** 错误/提示消息 */
  message?: string;
}

/** 当前推送状态(供 IPC 查询) */
let currentProgress: UpdaterProgressPayload = { state: 'idle' };

/** 事件订阅是否已挂载(避免重复注册监听器) */
let listenerBound = false;

/** 记录已下载就绪的版本,避免重复下载 */
let downloadedVersion: string | null = null;

/**
 * 推送当前状态到渲染层并缓存
 */
function pushState(partial: Partial<UpdaterProgressPayload>): void {
  currentProgress = { ...currentProgress, ...partial };
  broadcast('updater:progress', currentProgress);
}

/**
 * 挂载 electron-updater 事件监听(仅在首次调用时执行一次)
 */
async function ensureListeners(): Promise<void> {
  const updater = await getAutoUpdater();
  if (!updater || listenerBound) return;
  listenerBound = true;

  updater.on('checking-for-update', () => {
    pushState({ state: 'checking', message: '正在检查更新...' });
  });

  updater.on('update-available', (info: UpdateInfo) => {
    pushState({
      state: 'available',
      newVersion: info.version,
      message: `发现新版本 v${info.version}`,
    });
  });

  updater.on('update-not-available', (info: UpdateInfo) => {
    pushState({
      state: 'no-update',
      newVersion: info.version,
      message: '当前已是最新版本',
    });
  });

  updater.on('download-progress', (progress: ProgressInfo) => {
    const total = progress.total ?? 0;
    const percent = total > 0 ? Math.round((progress.transferred / total) * 100) : 0;
    pushState({
      state: 'downloading',
      percent,
      transferred: progress.transferred,
      total,
      bytesPerSecond: progress.bytesPerSecond,
      message: `下载更新 ${percent}%`,
    });
  });

  updater.on('update-downloaded', (info: UpdateInfo) => {
    downloadedVersion = info.version;
    pushState({
      state: 'downloaded',
      newVersion: info.version,
      percent: 100,
      message: `更新 v${info.version} 已下载完成,重启后生效`,
    });
  });

  updater.on('error', (err: Error) => {
    pushState({
      state: 'error',
      message: `更新出错:${err.message}`,
    });
  });
}

/**
 * 检查更新(静默检查,发现新版本仅提示,不自动下载)
 * 返回当前更新状态(供 UI 首次加载时同步)
 */
export async function checkForUpdates(): Promise<UpdaterProgressPayload> {
  const updater = await getAutoUpdater();
  if (!updater) {
    pushState({ state: 'disabled', message: '开发环境,自动更新不可用' });
    return currentProgress;
  }
  await ensureListeners();
  try {
    await updater.checkForUpdates();
  } catch (err) {
    pushState({ state: 'checking-error', message: `检查更新失败:${err instanceof Error ? err.message : String(err)}` });
  }
  return currentProgress;
}

/**
 * 下载最新更新
 * 若已下载完成则直接返回;下载中重复调用返回当前状态。
 */
export async function downloadUpdate(): Promise<UpdaterProgressPayload> {
  const updater = await getAutoUpdater();
  if (!updater) {
    pushState({ state: 'disabled', message: '开发环境,自动更新不可用' });
    return currentProgress;
  }
  await ensureListeners();
  // 已下载就绪则无需重复下载
  if (downloadedVersion) {
    pushState({ state: 'downloaded', newVersion: downloadedVersion, percent: 100 });
    return currentProgress;
  }
  try {
    await updater.downloadUpdate();
  } catch (err) {
    pushState({ state: 'error', message: `下载更新失败:${err instanceof Error ? err.message : String(err)}` });
  }
  return currentProgress;
}

/**
 * 立即安装并重启(退出当前应用,运行安装包)
 * 返回是否已触发安装
 */
export async function installAndRestart(): Promise<boolean> {
  const updater = await getAutoUpdater();
  if (!updater) return false;
  try {
    await updater.quitAndInstall();
    return true;
  } catch (err) {
    pushState({ state: 'error', message: `安装更新失败:${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/** 查询当前更新状态(供渲染层首次挂载同步) */
export function getUpdateStatus(): UpdaterProgressPayload {
  if (!app.isPackaged) {
    return { state: 'disabled', message: '开发环境,自动更新不可用' };
  }
  return currentProgress;
}
