/**
 * 微信视频号(视频号助手)平台适配器
 *
 * 职责:实现视频号助手创作平台的登录、登录检测、登出与视频发布流程
 *
 * 平台特性:
 *   - 创作平台:https://channels.weixin.qq.com/platform(微信扫码登录)
 *   - 动态发布页:https://channels.weixin.qq.com/platform/post/create
 *   - 标题/描述:富文本编辑器(contenteditable)或 textarea
 *   - 发布:点击「发表」/「发布」按钮
 *
 * 注意:视频号助手页面结构可能随平台更新变化,选择器采用多候选回退策略,
 *       若失效需根据实际页面结构调整选择器。
 */
import type { Page } from 'playwright-core';
import type { PublishParams } from '../types';
import { BasePlatformAdapter } from './base-adapter';
import { logger } from '../../../utils/logger';

/**
 * SpzxAdapter 微信视频号平台适配器
 * platform 标识为 'shipinhao'(视频号拼音),与平台中文名直接对应
 */
export class SpzxAdapter extends BasePlatformAdapter {
  /** 构造视频号适配器,platform 固定为 'shipinhao' */
  constructor() {
    super('shipinhao');
  }

  /** 登录页 URL(视频号助手登录页;未登录时 /platform 也会重定向到此) */
  protected getLoginUrl(): string {
    return 'https://channels.weixin.qq.com/login.html';
  }

  /** 上传页 URL(动态发布) */
  protected getUploadUrl(): string {
    return 'https://channels.weixin.qq.com/platform/post/create';
  }

  /** 已登录指示选择器(登录后顶部账户头像/昵称) */
  protected getLoggedInIndicator(): string {
    return '[class*="avatar"], [class*="nickname"], [class*="user-info"]';
  }

  /**
   * 检测页面是否已登录(多候选)
   * @param page 页面对象
   * @returns 是否已登录
   */
  protected async isPageLoggedIn(page: Page): Promise<boolean> {
    const hit = await this.waitForAnySelector(
      page,
      ['[class*="avatar"]', '[class*="nickname"]', '[class*="user-info"]', '[class*="account"]'],
      5000,
    );
    return hit !== null;
  }

  /**
   * 打印关键选择器的诊断命中信息(供登录后实测联调定位页面结构)
   * 若发布流程某一步失败,查看日志即可知道应调整哪个选择器。
   * @param page 页面对象
   * @param phase 阶段标识(如 上传/填表/发表)
   * @param selectors 待诊断的选择器数组
   */
  private async diagnoseSelectors(page: Page, phase: string, selectors: string[]): Promise<void> {
    try {
      const counts: string[] = [];
      for (const s of selectors) {
        const n = await page.locator(s).count();
        counts.push(`${s}=${n}`);
      }
      logger.info(
        `[auto-publish/spzx] ${phase}: URL=${page.url()} 页面标题=${JSON.stringify(await page.title())}`,
      );
      logger.info(`[auto-publish/spzx] ${phase} 选择器命中: ${counts.join(' , ')}`);
    } catch (e) {
      logger.warn(`[auto-publish/spzx] ${phase} 诊断失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 上传视频文件
   * 通过 input[type=file] 设置文件,等待上传完成(发表按钮可点击)
   * @param page 页面对象
   * @param params 发布参数(取 videoPath)
   */
  protected async doUpload(page: Page, params: PublishParams): Promise<void> {
    await this.diagnoseSelectors(page, '上传', [
      'input[type="file"]',
      'button:has-text("发表")',
      'button:has-text("发布")',
      '[class*="publish"]',
    ]);
    const ok = await this.setInputFilesSafe(page, 'input[type="file"]', params.videoPath);
    if (!ok) {
      throw new Error('视频号:未找到视频上传入口(input[type=file])');
    }
    const done = await this.waitForUploadDone(page, [
      'button:has-text("发表")',
      'button:has-text("发布")',
      'button[class*="publish"]',
      '[class*="submit"]:not([disabled])',
    ]);
    if (!done) {
      throw new Error('视频号:视频上传超时,未检测到发表按钮');
    }
  }

  /**
   * 填写标题/描述(带话题)、封面
   * 视频号助手使用富文本编辑器,标题(含话题)填入主编辑器
   * @param page 页面对象
   * @param params 发布参数
   */
  protected async doFillForm(page: Page, params: PublishParams): Promise<void> {
    await this.diagnoseSelectors(page, '填表', [
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea',
      'input[class*="title"]',
    ]);
    const titleWithTags = this.buildTitleWithTags(params.title, params.tags);
    await this.fillAnyInputSafe(
      page,
      ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea', 'input[class*="title"]'],
      titleWithTags,
    );

    if (params.coverPath) {
      await this.clickAnySafe(page, ['[class*="cover"]', 'button:has-text("封面")'], 5000);
      await this.setInputFilesSafe(page, 'input[type="file"][accept*="image"]', params.coverPath);
    }
  }

  /**
   * 点击发表按钮
   * @param page 页面对象
   */
  protected async doSubmit(page: Page): Promise<void> {
    await this.diagnoseSelectors(page, '发表', [
      'button:has-text("发表")',
      'button:has-text("发布")',
      'button[class*="publish"]',
      '[class*="submit"]:not([disabled])',
    ]);
    const ok = await this.clickAnySafe(page, [
      'button:has-text("发表")',
      'button:has-text("发布")',
      'button[class*="publish"]',
      '[class*="submit"]:not([disabled])',
    ]);
    if (!ok) {
      throw new Error('视频号:未找到发表按钮');
    }
    await this.sleep(3000);
  }
}
