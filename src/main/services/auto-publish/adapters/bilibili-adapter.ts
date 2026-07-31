/**
 * 哔哩哔哩(B站)创作者平台适配器
 *
 * 职责:实现B站创作者中心的登录、登录检测、登出与视频发布流程
 *
 * 平台特性:
 *   - 登录/上传页:https://member.bilibili.com/platform/upload/video/frame
 *   - 标题输入:input
 *   - 发布:点击「立即投稿」按钮
 *
 * 注意:B站页面结构可能随平台更新变化,选择器采用多候选回退策略。
 */
import type { Page } from 'playwright-core';
import type { PublishParams } from '../types';
import { BasePlatformAdapter } from './base-adapter';

/**
 * BilibiliAdapter B站平台适配器
 */
export class BilibiliAdapter extends BasePlatformAdapter {
  /** 构造B站适配器,platform 固定为 'bilibili' */
  constructor() {
    super('bilibili');
  }

  /** 登录页 URL */
  protected getLoginUrl(): string {
    return 'https://member.bilibili.com/platform/upload/video/frame';
  }

  /** 上传页 URL */
  protected getUploadUrl(): string {
    return 'https://member.bilibili.com/platform/upload/video/frame';
  }

  /** 已登录指示选择器(登录后用户信息) */
  protected getLoggedInIndicator(): string {
    return '[class*="user"], [class*="avatar"], [class*="nickname"], [class*="header-user"]';
  }

  /**
   * 检测页面是否已登录(多候选)
   * @param page 页面对象
   * @returns 是否已登录
   */
  protected async isPageLoggedIn(page: Page): Promise<boolean> {
    const hit = await this.waitForAnySelector(
      page,
      ['[class*="user-info"]', '[class*="avatar"]', '[class*="nickname"]', '[class*="header-user"]'],
      5000,
    );
    return hit !== null;
  }

  /**
   * 上传视频文件
   * @param page 页面对象
   * @param params 发布参数(取 videoPath)
   */
  protected async doUpload(page: Page, params: PublishParams): Promise<void> {
    const ok = await this.setInputFilesSafe(page, 'input[type="file"]', params.videoPath);
    if (!ok) {
      throw new Error('B站:未找到视频上传入口(input[type=file])');
    }
    const done = await this.waitForUploadDone(page, [
      'button:has-text("立即投稿")',
      'button:has-text("发布")',
      'button[class*="submit"]',
      'button[class*="publish"]:not([disabled])',
    ]);
    if (!done) {
      throw new Error('B站:视频上传超时,未检测到投稿按钮');
    }
  }

  /**
   * 填写标题(带话题)、描述、封面
   * @param page 页面对象
   * @param params 发布参数
   */
  protected async doFillForm(page: Page, params: PublishParams): Promise<void> {
    const titleWithTags = this.buildTitleWithTags(params.title, params.tags);
    await this.fillAnyInputSafe(
      page,
      ['input[class*="title"]', 'textarea[class*="title"]', 'input', '.ql-editor[contenteditable="true"]'],
      titleWithTags,
    );

    if (params.description) {
      await this.fillAnyInputSafe(
        page,
        ['textarea[class*="desc"]', 'textarea[class*="description"]', 'textarea'],
        params.description,
      );
    }

    if (params.coverPath) {
      await this.clickAnySafe(page, ['[class*="cover"]', 'button:has-text("封面")'], 5000);
      await this.setInputFilesSafe(page, 'input[type="file"][accept*="image"]', params.coverPath);
    }
  }

  /**
   * 点击发布按钮(立即投稿)
   * @param page 页面对象
   */
  protected async doSubmit(page: Page): Promise<void> {
    const ok = await this.clickAnySafe(page, [
      'button:has-text("立即投稿")',
      'button:has-text("发布")',
      'button[class*="submit"]',
      'button[class*="publish"]:not([disabled])',
    ]);
    if (!ok) {
      throw new Error('B站:未找到投稿/发布按钮');
    }
    await this.sleep(3000);
  }
}
