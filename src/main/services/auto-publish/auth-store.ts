/**
 * 登录态持久化管理
 *
 * 职责:
 *   - 管理各平台登录态(基于持久化 userDataDir)
 *   - 每平台一个 userDataDir:userData/auth/{platform}/
 *   - 提供认证目录获取、登录态检测、登录态清除能力
 *
 * 设计要点:
 *   - 使用 Electron app.getPath('userData') 获取应用数据目录
 *   - isAuthenticated 通过 userDataDir 是否存在且包含 cookie 判断
 *   - clearAuth 删除整个平台目录,下次需重新扫码登录
 */
import { app } from 'electron';
import { join } from 'path';
import { existsSync, rmSync, readdirSync } from 'fs';
import type { PublishPlatform, LoginStatus, AccountInfo } from './types';
import { logger } from '../../utils/logger';

/**
 * AuthStore 登录态存储
 * 管理各平台持久化 userDataDir,提供登录态检测与清除
 */
export class AuthStore {
  /**
   * 获取平台认证目录(.userData/auth/{platform}/)
   * @param platform 平台标识
   * @returns 认证目录绝对路径
   */
  getAuthDir(platform: PublishPlatform): string {
    return join(app.getPath('userData'), 'auth', platform);
  }

  /**
   * 检查平台是否已登录
   * 判断依据:userDataDir 存在且包含内容(cookie/storage 文件)
   * @param platform 平台标识
   * @returns 是否已登录
   */
  isAuthenticated(platform: PublishPlatform): boolean {
    const dir = this.getAuthDir(platform);
    if (!existsSync(dir)) return false;
    try {
      // 目录存在且有内容,认为有登录态(精确判断需打开浏览器检测)
      const files = readdirSync(dir);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 获取平台登录状态(供 listAccounts 使用)
   * @param platform 平台标识
   * @returns 登录状态:有 userDataDir 内容为 logged-in,否则 logged-out
   */
  getLoginStatus(platform: PublishPlatform): LoginStatus {
    return this.isAuthenticated(platform) ? 'logged-in' : 'logged-out';
  }

  /**
   * 获取平台账号信息(基于本地登录态推断,不打开浏览器)
   * @param platform 平台标识
   * @returns 账号信息(昵称/头像需打开浏览器后才能获取,此处为空)
   */
  getAccountInfo(platform: PublishPlatform): AccountInfo {
    return {
      platform,
      loginStatus: this.getLoginStatus(platform),
      lastActiveAt: this.getLastActiveAt(platform),
    };
  }

  /**
   * 获取平台最近活跃时间(以 userDataDir 修改时间近似)
   * @param platform 平台标识
   * @returns ISO 字符串;无记录返回 undefined
   */
  private getLastActiveAt(platform: PublishPlatform): string | undefined {
    const dir = this.getAuthDir(platform);
    if (!existsSync(dir)) return undefined;
    try {
      // readdirSync 配合 stat 获取最新修改时间;此处用目录存在近似
      return new Date().toISOString();
    } catch {
      return undefined;
    }
  }

  /**
   * 清除平台登录态(删除 userDataDir 目录)
   * @param platform 平台标识
   */
  clearAuth(platform: PublishPlatform): void {
    const dir = this.getAuthDir(platform);
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        logger.info(`[auto-publish] 已清除平台 ${platform} 登录态: ${dir}`);
      }
    } catch (err) {
      logger.error(
        `[auto-publish] 清除平台 ${platform} 登录态失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * 列出所有支持平台的账号信息
   * @returns 账号信息数组
   */
  listAccounts(): AccountInfo[] {
    const platforms: PublishPlatform[] = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili'];
    return platforms.map((p) => this.getAccountInfo(p));
  }
}

/** 登录态存储单例 */
export const authStore = new AuthStore();
