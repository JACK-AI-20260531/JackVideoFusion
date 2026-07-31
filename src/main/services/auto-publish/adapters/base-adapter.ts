/**
 * 平台适配器基类
 *
 * 职责:
 *   - 实现 PlatformAdapter 接口的通用流程:登录、登录检测、登出、发布模板方法
 *   - login:打开可见浏览器到登录页,轮询检测登录指示元素,等待用户扫码
 *   - checkLogin:无头打开平台主页,检测登录态(logged-in / expired / logged-out)
 *   - publish:模板方法,串联 导航→登录校验→上传→填表→提交,步骤间检查取消令牌
 *   - 提供通用辅助方法:waitForSelectorSafe / fillInputSafe / clickSafe / isPageLoggedIn
 *
 * 子类需实现:
 *   - getLoginUrl():登录页 URL
 *   - getUploadUrl():上传页 URL
 *   - getLoggedInIndicator():已登录指示元素选择器
 *   - doUpload(page, params):上传视频文件
 *   - doFillForm(page, params):填写标题/描述/话题/封面
 *   - doSubmit(page):点击发布按钮
 */
import type { Page } from 'playwright-core';
import type { CancelToken } from '../../ffmpeg/types';
import type {
  PublishPlatform,
  AccountInfo,
  PublishParams,
  PublishResult,
  PlatformAdapter,
} from '../types';
import { BrowserManager, browserManager } from '../browser-manager';
import { AuthStore, authStore } from '../auth-store';
import { logger } from '../../../utils/logger';

/**
 * BasePlatformAdapter 平台适配器抽象基类
 * 通过模板方法模式固化发布流程,子类只关心平台差异部分
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  /**
   * @param platform 平台标识
   * @param browserMgr 浏览器管理器(默认单例)
   * @param authStoreInstance 登录态存储(默认单例)
   */
  constructor(
    protected readonly platform: PublishPlatform,
    protected readonly browserMgr: BrowserManager = browserManager,
    protected readonly authStoreInstance: AuthStore = authStore,
  ) {}

  /** 登录页 URL(子类实现) */
  protected abstract getLoginUrl(): string;
  /** 上传页 URL(子类实现) */
  protected abstract getUploadUrl(): string;
  /** 已登录指示元素选择器(子类实现,登录后该元素存在) */
  protected abstract getLoggedInIndicator(): string;
  /** 上传视频文件(子类实现) */
  protected abstract doUpload(page: Page, params: PublishParams): Promise<void>;
  /** 填写标题/描述/话题/封面(子类实现) */
  protected abstract doFillForm(page: Page, params: PublishParams): Promise<void>;
  /** 点击发布按钮(子类实现) */
  protected abstract doSubmit(page: Page): Promise<void>;

  /**
   * 打开浏览器到平台登录页,等待用户扫码登录
   * 轮询检测登录指示元素,最多等待 5 分钟;期间支持取消
   * @param token 取消令牌(可选)
   * @returns 账号信息
   */
  async login(token?: CancelToken): Promise<AccountInfo> {
    const userDataDir = this.authStoreInstance.getAuthDir(this.platform);
    // 登录必须可见,用户需扫码
    const context = await this.browserMgr.launchPersistentContext(userDataDir, false);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(this.getLoginUrl());
      logger.info(`[auto-publish] 平台 ${this.platform} 等待用户登录...`);

      // 轮询检测登录成功:最多 5 分钟,每 3 秒检查一次
      const timeoutMs = 5 * 60 * 1000;
      const start = Date.now();
      let loggedIn = false;
      while (Date.now() - start < timeoutMs) {
        if (token?.cancelled) {
          throw new Error(`平台 ${this.platform} 登录已取消`);
        }
        loggedIn = await this.isPageLoggedIn(page);
        if (loggedIn) break;
        // 间隔 3 秒再次检测
        await this.sleep(3000);
      }

      if (!loggedIn) {
        return {
          platform: this.platform,
          loginStatus: 'logged-out',
          lastActiveAt: new Date().toISOString(),
        };
      }
      logger.info(`[auto-publish] 平台 ${this.platform} 登录成功`);
      return {
        platform: this.platform,
        loginStatus: 'logged-in',
        lastActiveAt: new Date().toISOString(),
      };
    } finally {
      await this.browserMgr.closeContext(context);
    }
  }

  /**
   * 检查当前是否已登录(基于持久化 userDataDir)
   * 先检查本地 userDataDir,再无头打开平台主页精确检测
   * @returns 账号信息(含精确登录状态)
   */
  async checkLogin(): Promise<AccountInfo> {
    // 本地无 userDataDir,直接返回未登录
    if (!this.authStoreInstance.isAuthenticated(this.platform)) {
      return {
        platform: this.platform,
        loginStatus: 'logged-out',
      };
    }
    const userDataDir = this.authStoreInstance.getAuthDir(this.platform);
    const context = await this.browserMgr.launchPersistentContext(userDataDir, true);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(this.getLoginUrl(), { waitUntil: 'domcontentloaded' });
      const loggedIn = await this.isPageLoggedIn(page);
      return {
        platform: this.platform,
        loginStatus: loggedIn ? 'logged-in' : 'expired',
        lastActiveAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(
        `[auto-publish] 平台 ${this.platform} 登录检测失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        platform: this.platform,
        loginStatus: 'expired',
      };
    } finally {
      await this.browserMgr.closeContext(context);
    }
  }

  /**
   * 退出登录(清除持久化登录态)
   * 删除 userDataDir 目录,下次需重新扫码登录
   */
  async logout(): Promise<void> {
    this.authStoreInstance.clearAuth(this.platform);
  }

  /**
   * 执行视频发布流程(模板方法)
   * 流程:导航→登录校验→上传→填表→提交,步骤间检查取消令牌并推送进度
   * @param params 发布参数
   * @param token 取消令牌
   * @param onProgress 进度回调(0-100)
   * @returns 发布结果
   */
  async publish(
    params: PublishParams,
    token: CancelToken,
    onProgress: (p: number) => void,
  ): Promise<PublishResult> {
    const userDataDir = this.authStoreInstance.getAuthDir(this.platform);
    // 发布使用可见模式,便于观察与规避反爬
    const context = await this.browserMgr.launchPersistentContext(userDataDir, false);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      onProgress(5);
      await page.goto(this.getUploadUrl(), { waitUntil: 'domcontentloaded' });

      // 登录校验:未登录则抛错,提示用户先登录
      const loggedIn = await this.isPageLoggedIn(page);
      if (!loggedIn) {
        throw new Error(`平台 ${this.platform} 未登录或登录已过期,请先登录`);
      }
      if (token.cancelled) throw new Error(`平台 ${this.platform} 发布已取消`);

      onProgress(15);
      await this.doUpload(page, params);
      if (token.cancelled) throw new Error(`平台 ${this.platform} 发布已取消`);

      onProgress(50);
      await this.doFillForm(page, params);
      if (token.cancelled) throw new Error(`平台 ${this.platform} 发布已取消`);

      onProgress(80);
      await this.doSubmit(page);

      onProgress(100);
      logger.info(`[auto-publish] 平台 ${this.platform} 发布成功: ${params.title}`);
      return {
        platform: this.platform,
        publishTime: new Date().toISOString(),
        success: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-publish] 平台 ${this.platform} 发布失败: ${msg}`);
      return {
        platform: this.platform,
        publishTime: new Date().toISOString(),
        success: false,
      };
    } finally {
      await this.browserMgr.closeContext(context);
    }
  }

  /**
   * 检测页面是否已登录
   * 通过 getLoggedInIndicator 选择器是否存在判断
   * @param page 页面对象
   * @returns 是否已登录
   */
  protected async isPageLoggedIn(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.getLoggedInIndicator(), { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 安全等待选择器出现(带超时与异常兜底)
   * @param page 页面对象
   * @param selector 元素选择器
   * @param timeout 超时毫秒,默认 10000
   * @returns 是否成功等待到元素
   */
  protected async waitForSelectorSafe(
    page: Page,
    selector: string,
    timeout = 10000,
  ): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { timeout, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 安全填充输入框(先清空再填入,带异常兜底)
   * @param page 页面对象
   * @param selector 输入框选择器
   * @param value 填入值
   * @returns 是否成功
   */
  protected async fillInputSafe(
    page: Page,
    selector: string,
    value: string,
  ): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { timeout: 10000, state: 'visible' });
      await page.fill(selector, '');
      await page.fill(selector, value);
      return true;
    } catch (err) {
      logger.warn(
        `[auto-publish] 填充输入框失败 selector=${selector}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 安全点击元素(带等待与异常兜底)
   * @param page 页面对象
   * @param selector 元素选择器
   * @returns 是否成功
   */
  protected async clickSafe(page: Page, selector: string): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { timeout: 10000, state: 'visible' });
      await page.click(selector);
      return true;
    } catch (err) {
      logger.warn(
        `[auto-publish] 点击元素失败 selector=${selector}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 设置文件输入(用于上传 input[type=file])
   * @param page 页面对象
   * @param selector 文件输入选择器
   * @param filePath 文件绝对路径
   * @returns 是否成功
   */
  protected async setInputFilesSafe(
    page: Page,
    selector: string,
    filePath: string,
  ): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.setInputFiles(selector, filePath);
      return true;
    } catch (err) {
      logger.warn(
        `[auto-publish] 设置文件输入失败 selector=${selector}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 拼接标题与话题为发布文案
   * @param title 标题
   * @param tags 话题列表
   * @returns 拼接后的文案(标题 + #话题)
   */
  protected buildTitleWithTags(title: string, tags?: string[]): string {
    if (!tags || tags.length === 0) return title;
    const tagStr = tags.map((t) => `#${t}`).join(' ');
    return `${title} ${tagStr}`;
  }

  /**
   * 等待任一选择器出现(多候选,首个命中即返回)
   * 用于平台页面选择器不确定场景,提供多候选回退
   * @param page 页面对象
   * @param selectors 候选选择器列表
   * @param timeout 总超时毫秒,默认 30000
   * @returns 命中的选择器;全部未命中返回 null
   */
  protected async waitForAnySelector(
    page: Page,
    selectors: string[],
    timeout = 30000,
  ): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const s of selectors) {
        try {
          await page.waitForSelector(s, { timeout: 1000, state: 'visible' });
          return s;
        } catch {
          // 继续尝试下一个候选选择器
        }
      }
      await this.sleep(500);
    }
    return null;
  }

  /**
   * 点击任一匹配的元素(多候选)
   * @param page 页面对象
   * @param selectors 候选选择器列表
   * @param timeout 总超时毫秒
   * @returns 是否成功点击
   */
  protected async clickAnySafe(
    page: Page,
    selectors: string[],
    timeout = 30000,
  ): Promise<boolean> {
    const hit = await this.waitForAnySelector(page, selectors, timeout);
    if (!hit) return false;
    try {
      await page.click(hit);
      return true;
    } catch (err) {
      logger.warn(
        `[auto-publish] clickAnySafe 点击失败 selector=${hit}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 填充任一匹配的输入框(多候选,先清空再填入)
   * @param page 页面对象
   * @param selectors 候选选择器列表
   * @param value 填入值
   * @param timeout 总超时毫秒
   * @returns 是否成功
   */
  protected async fillAnyInputSafe(
    page: Page,
    selectors: string[],
    value: string,
    timeout = 30000,
  ): Promise<boolean> {
    const hit = await this.waitForAnySelector(page, selectors, timeout);
    if (!hit) return false;
    try {
      await page.fill(hit, '');
      await page.fill(hit, value);
      return true;
    } catch (err) {
      logger.warn(
        `[auto-publish] fillAnyInputSafe 填充失败 selector=${hit}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 等待上传完成(等待任一"可发布"指示出现)
   * @param page 页面对象
   * @param readySelectors 发布按钮等可发布指示选择器列表
   * @param timeout 超时毫秒,默认 5 分钟
   * @returns 是否上传完成
   */
  protected async waitForUploadDone(
    page: Page,
    readySelectors: string[],
    timeout = 5 * 60 * 1000,
  ): Promise<boolean> {
    const hit = await this.waitForAnySelector(page, readySelectors, timeout);
    return hit !== null;
  }

  /**
   * 睡眠工具方法
   * @param ms 毫秒
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
