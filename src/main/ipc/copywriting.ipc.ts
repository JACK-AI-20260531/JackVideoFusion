/**
 * 发布文案 AI 助手 IPC 注册(PRD-v2.2 FR-2)
 * 职责:将 copywriting 服务的文案生成能力暴露为 copywriting:* 通道
 *
 * 通道列表:
 *   copywriting:generate - 生成平台风格文案(3 候选标题 + 描述 + 话题标签)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { generateCopywriting } from '../services/copywriting';
import { PLATFORM_STYLE } from '../services/copywriting/copywriting';
import type { PublishPlatform } from '../services/auto-publish/types';

/** 合法平台白名单(入参校验用) */
const VALID_PLATFORMS = new Set(Object.keys(PLATFORM_STYLE));

/**
 * 注册文案生成 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 生成平台风格文案
   * payload: { title: string, platform: PublishPlatform }
   * 返回: { ok, data?: Copywriting, error?: string }
   */
  safeHandle(ipc, 'copywriting:generate', async (_event, payload) => {
    const p = payload as { title?: string; platform?: string } | undefined;
    if (!p || typeof p.title !== 'string' || p.title.trim().length === 0) {
      throw new Error('copywriting:generate 参数无效:标题不能为空');
    }
    if (p.title.length > 100) {
      throw new Error('copywriting:generate 参数无效:标题不能超过 100 字');
    }
    if (!p.platform || typeof p.platform !== 'string' || !VALID_PLATFORMS.has(p.platform)) {
      throw new Error('copywriting:generate 参数无效:平台非法');
    }
    return generateCopywriting(p.title, p.platform as PublishPlatform);
  });
}
