/**
 * Playwright 浏览器管理
 *
 * 职责:
 *   - 基于 playwright-core 的 chromium 驱动系统已安装的 Chrome/Edge(避免重复下载浏览器)
 *   - 提供普通浏览器实例启动(launch)与持久化上下文启动(launchPersistentContext)
 *   - 查找系统浏览器可执行文件路径(Windows 常见安装路径)
 *   - 统一关闭由本管理器创建的浏览器实例
 *
 * 设计要点:
 *   - 使用 playwright-core 而非 playwright,不触发浏览器下载
 *   - launchPersistentContext 用于登录态持久化:userDataDir 存储 cookie/storage
 *   - 所有启动操作加 try-catch 与超时保护,避免阻塞主进程
 */
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger';

/**
 * BrowserManager 浏览器管理器
 * 封装 playwright-core chromium 的启动与生命周期管理
 */
export class BrowserManager {
  /** 已创建的浏览器实例集合(用于统一关闭) */
  private browsers = new Set<Browser>();
  /** 已创建的持久化上下文集合(用于统一关闭) */
  private contexts = new Set<BrowserContext>();
  /** 缓存的系统浏览器路径(避免重复查找) */
  private cachedExecutablePath: string | null = null;

  /**
   * 查找系统浏览器可执行文件路径
   * 优先级:Chrome > Edge,依次检查 Windows 常见安装路径
   * @returns 浏览器可执行文件绝对路径;未找到返回 null
   */
  findSystemBrowser(): string | null {
    if (this.cachedExecutablePath) return this.cachedExecutablePath;

    // Windows 常见浏览器安装路径(按优先级排列)
    const candidates: string[] = [
      // Chrome
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      // Edge
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    for (const p of candidates) {
      if (p && existsSync(p)) {
        this.cachedExecutablePath = p;
        logger.info(`[auto-publish] 找到系统浏览器: ${p}`);
        return p;
      }
    }
    logger.warn('[auto-publish] 未找到系统 Chrome/Edge,请确认已安装');
    return null;
  }

  /**
   * 启动普通浏览器实例(无持久化上下文,用于一次性操作)
   * @param headless 是否无头模式,默认 true
   * @returns Browser 实例
   */
  async launch(headless = true): Promise<Browser> {
    const executablePath = this.findSystemBrowser();
    if (!executablePath) {
      throw new Error('未找到系统 Chrome/Edge 浏览器,请先安装 Chrome 或 Edge');
    }
    const browser = await chromium.launch({ executablePath, headless });
    this.browsers.add(browser);
    logger.info(`[auto-publish] 启动浏览器实例(headless=${headless})`);
    return browser;
  }

  /**
   * 启动持久化上下文(用于登录态持久化)
   * userDataDir 存储 cookie/localStorage,扫码登录后下次免登录
   * @param userDataDir 用户数据目录(持久化登录态)
   * @param headless 是否无头模式,默认 false(登录需用户扫码,必须可见)
   * @returns BrowserContext 实例
   */
  async launchPersistentContext(userDataDir: string, headless = false): Promise<BrowserContext> {
    const executablePath = this.findSystemBrowser();
    if (!executablePath) {
      throw new Error('未找到系统 Chrome/Edge 浏览器,请先安装 Chrome 或 Edge');
    }
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      // 登录与发布需要可见视口,避免响应式布局隐藏元素
      viewport: { width: 1280, height: 800 },
    });
    this.contexts.add(context);
    logger.info(
      `[auto-publish] 启动持久化上下文 userDataDir=${userDataDir}, headless=${headless}`,
    );
    return context;
  }

  /**
   * 关闭单个浏览器上下文并从跟踪集合移除
   * @param context 待关闭的上下文
   */
  async closeContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch (err) {
      logger.warn(
        `[auto-publish] 关闭上下文失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.contexts.delete(context);
    }
  }

  /**
   * 关闭所有由本管理器创建的浏览器实例与上下文
   * 应在应用退出或模块卸载时调用
   */
  async close(): Promise<void> {
    // 先关闭上下文,再关闭浏览器
    for (const ctx of this.contexts) {
      try {
        await ctx.close();
      } catch {
        // 忽略关闭错误
      }
    }
    this.contexts.clear();

    for (const browser of this.browsers) {
      try {
        await browser.close();
      } catch {
        // 忽略关闭错误
      }
    }
    this.browsers.clear();
    logger.info('[auto-publish] 已关闭所有浏览器实例与上下文');
  }
}

/** 浏览器管理器单例 */
export const browserManager = new BrowserManager();
