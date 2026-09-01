/**
 * 半自动发布降级服务(PRD-v1.7 数据飞轮与全景矩阵 FR-4)
 *
 * 职责:
 *   - 物料包落盘:userData/auto-publish/kits/{taskId}.json(标题/描述/标签/视频/封面上传页地址)
 *   - 打开平台上传页:可见浏览器复用持久化登录态,上下文不关闭,留给用户手动完成发布
 *
 * 设计要点:
 *   - 薄 I/O 层:kit 构造与预检在 publish-spec.ts(纯函数),本文件只做文件与浏览器操作
 *   - 发布队列经依赖注入使用(单测可注入 mock 绕开 electron/playwright)
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { authStore } from './auth-store';
import { browserManager } from './browser-manager';
import { PUBLISH_SPECS } from './publish-spec';
import type { PublishKit } from './publish-spec';
import type { PublishPlatform } from './types';
import { logger } from '../../utils/logger';

/**
 * 物料包落盘路径(userData/auto-publish/kits/{taskId}.json)
 * @param taskId 任务 ID
 * @returns 文件绝对路径
 */
export function kitFilePath(taskId: string): string {
  return join(app.getPath('userData'), 'auto-publish', 'kits', `${taskId}.json`);
}

/**
 * 写入半自动发布物料包(JSON)
 * @param kit 物料包对象
 * @returns 落盘路径
 */
export async function writePublishKit(kit: PublishKit): Promise<string> {
  const fp = kitFilePath(kit.taskId);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(kit, null, 2), 'utf8');
  logger.info(`[assisted-publish] 物料包已生成: ${fp}`);
  return fp;
}

/**
 * 打开平台上传页(可见浏览器,复用持久化登录态)
 * 上下文不主动关闭:浏览器留给用户手动完成上传与发布
 * @param platform 平台标识
 */
export async function openAssistedUpload(platform: PublishPlatform): Promise<void> {
  const spec = PUBLISH_SPECS[platform];
  const userDataDir = authStore.getAuthDir(platform);
  const context = await browserManager.launchPersistentContext(userDataDir, false);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(spec.uploadUrl, { waitUntil: 'domcontentloaded' });
  logger.info(`[assisted-publish] 已打开平台 ${platform} 上传页: ${spec.uploadUrl}`);
}
