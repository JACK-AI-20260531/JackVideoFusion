/**
 * 抖音创作者平台适配器
 *
 * 职责:实现抖音创作者中心的登录、登录检测、登出与视频发布流程
 *
 * 平台特性:
 *   - 登录页:https://creator.douyin.com/(扫码登录,登录后跳转创作者中心)
 *   - 上传页:https://creator.douyin.com/creator-micro/content/upload
 *   - 标题输入:富文本编辑器(ql-editor)或 textarea
 *   - 发布:点击「发布」按钮
 *
 * 注意:抖音页面结构可能随平台更新变化,选择器采用多候选回退策略,
 *       若失效需根据实际页面结构调整选择器。
 */
import type { Page } from 'playwright-core';
import type { PublishParams } from '../types';
import { BasePlatformAdapter } from './base-adapter';

/**
 * DouyinAdapter 抖音平台适配器
 */
export class DouyinAdapter extends BasePlatformAdapter {
  /** 构造抖音适配器,platform 固定为 'douyin' */
  constructor() {
    super('douyin');
  }

  /** 登录页 URL */
  protected getLoginUrl(): string {
    return 'https://creator.douyin.com/';
  }

  /** 上传页 URL */
  protected getUploadUrl(): string {
    return 'https://creator.douyin.com/creator-micro/content/upload';
  }

  /** 已登录指示选择器(登录后创作者中心头像/用户信息) */
  protected getLoggedInIndicator(): string {
    return 'img[class*="avatar"], .user-avatar, [class*="user-info"]';
  }

  /**
   * 检测页面是否已登录(多候选)
   * @param page 页面对象
   * @returns 是否已登录
   */
  protected async isPageLoggedIn(page: Page): Promise<boolean> {
    const hit = await this.waitForAnySelector(
      page,
      ['img[class*="avatar"]', '.user-avatar', '[class*="user-info"]', '[class*="nickname"]'],
      5000,
    );
    return hit !== null;
  }

  /**
   * 上传视频文件
   * 通过 input[type=file] 设置文件,等待上传完成(发布按钮可点击)
   * @param page 页面对象
   * @param params 发布参数(取 videoPath)
   */
  protected async doUpload(page: Page, params: PublishParams): Promise<void> {
    // 抖音上传通过隐藏的 input[type=file] 接收文件
    const ok = await this.setInputFilesSafe(page, 'input[type="file"]', params.videoPath);
    if (!ok) {
      throw new Error('抖音:未找到视频上传入口(input[type=file])');
    }
    // 等待上传完成:发布按钮可点击或上传进度元素消失
    const done = await this.waitForUploadDone(page, [
      'button:has-text("发布")',
      'button.publish-btn',
      '[class*="publish"]:not([disabled])',
    ]);
    if (!done) {
      throw new Error('抖音:视频上传超时,未检测到发布按钮');
    }
  }

  /**
   * 填写标题(带话题)、描述、封面
   * @param page 页面对象
   * @param params 发布参数
   */
  protected async doFillForm(page: Page, params: PublishParams): Promise<void> {
    // 标题(含话题):抖音使用富文本编辑器或 textarea
    const titleWithTags = this.buildTitleWithTags(params.title, params.tags);
    await this.fillAnyInputSafe(
      page,
      ['.ql-editor[contenteditable="true"]', 'textarea[class*="title"]', 'textarea', 'input[class*="title"]'],
      titleWithTags,
    );

    // 描述(可选)
    if (params.description) {
      await this.fillAnyInputSafe(
        page,
        ['textarea[class*="desc"]', 'textarea[class*="description"]'],
        params.description,
      );
    }

    // 封面(可选):点击封面设置入口并设置文件
    if (params.coverPath) {
      await this.clickAnySafe(page, ['[class*="cover"]', 'button:has-text("封面")'], 5000);
      await this.setInputFilesSafe(page, 'input[type="file"][accept*="image"]', params.coverPath);
    }
  }

  /**
   * 点击发布按钮
   * @param page 页面对象
   */
  protected async doSubmit(page: Page): Promise<void> {
    const ok = await this.clickAnySafe(page, [
      'button:has-text("发布")',
      'button.publish-btn',
      '[class*="publish"]:not([disabled])',
    ]);
    if (!ok) {
      throw new Error('抖音:未找到发布按钮');
    }
    // 等待发布请求处理,避免过早关闭浏览器
    await this.sleep(3000);
  }
}
