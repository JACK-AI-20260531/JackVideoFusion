/**
 * Electron 主进程入口
 * 职责:创建窗口、初始化 IPC 服务、注册自动加载的服务模块
 */
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { registerAllIpc } from './ipc';

// 是否开发环境
const isDev = process.env.NODE_ENV === 'development';

// 主窗口实例引用
let mainWindow: BrowserWindow | null = null;

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
 * 应用就绪事件:创建窗口、注册 IPC
 */
app.whenReady().then(() => {
  mainWindow = createMainWindow();
  registerAllIpc();

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
