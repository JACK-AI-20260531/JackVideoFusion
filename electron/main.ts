/**
 * Electron 主进程入口
 * 职责:创建窗口、初始化 IPC 服务、启动恢复、退出清理
 */
import { app, BrowserWindow, shell, Menu, dialog } from 'electron';
import { join } from 'path';
import { registerAllIpc } from './ipc';
import { taskQueue } from '../src/main/services/task-queue';
import { browserManager } from '../src/main/services/auto-publish';
import { logger } from '../src/main/utils/logger';

// 是否开发环境
const isDev = process.env.NODE_ENV === 'development';

// 主窗口实例引用
let mainWindow: BrowserWindow | null = null;

// 退出清理是否已完成(避免 before-quit 重复触发)
let cleanupDone = false;

/**
 * 构建应用菜单栏(替换 Electron 默认菜单)
 */
function buildAppMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.reload(); },
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => { app.quit(); },
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新页面' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 AI智剪工坊',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'AI智剪工坊',
              detail: [
                '版本: v1.3.0',
                '',
                'AI批量视频混剪工具',
                '支持素材处理、视频混剪、AI剪辑、',
                '语音克隆、多平台自动发布',
                '',
                '作者: jackgoogle',
                '许可: MIT',
              ].join('\n'),
              buttons: ['确定'],
            });
          },
        },
        {
          label: '打开日志目录',
          click: () => {
            const logDir = join(app.getPath('userData'), 'logs');
            shell.openPath(logDir);
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * 创建应用主窗口
 */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 720,
    show: false,
    backgroundColor: '#0f1115',
    title: 'AI智剪工坊',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口准备好再显示,避免白屏
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools();
  });

  // 开发环境加载 Vite dev server,生产环境加载打包产物
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'));
  }

  return win;
}

/**
 * 退出清理:关闭 Playwright 浏览器实例,避免进程泄漏
 * 幂等设计:多次调用安全
 */
async function cleanupBeforeQuit(): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;
  try {
    await browserManager.close();
    logger.info('[App] 浏览器实例已清理');
  } catch (err) {
    logger.warn(`[App] 浏览器清理失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 单实例锁:避免多实例同时运行导致任务队列冲突
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二个实例直接退出
  app.quit();
} else {
  // 第二个实例被启动时,聚焦主窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  /**
   * 应用就绪事件:创建窗口、注册 IPC、启动恢复任务队列
   */
  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildAppMenu());
    mainWindow = createMainWindow();
    registerAllIpc();

    // 启动恢复:将上次崩溃残留的 running 任务转为 paused,支持断点续
    try {
      taskQueue.restoreOnStartup();
    } catch (err) {
      logger.warn(`[App] 任务队列启动恢复失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // macOS 激活时重新创建窗口
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  // 所有窗口关闭时退出(除 macOS)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 应用退出前清理资源(Playwright 浏览器实例)
  app.on('before-quit', (event) => {
    if (!cleanupDone) {
      // 阻止默认退出,等异步清理完成后再退出
      event.preventDefault();
      cleanupBeforeQuit().finally(() => {
        app.quit();
      });
    }
  });
}
