/**
 * 热点选题 IPC 注册(PRD-v1.7 FR-6)
 *
 * 通道列表:
 *   hot-topics:fetch          - 聚合抓取热榜(失败隔离)
 *   hot-topics:suggest        - 结合素材库生成选题建议(LLM)
 *   hot-topics:generateScript - 选题一键生成口播脚本并落盘
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { hotTopicService } from '../services/hot-topics';
import { logger } from '../utils/logger';

/**
 * 注册热点选题相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  // 聚合抓取热榜
  safeHandle(ipc, 'hot-topics:fetch', async () => {
    return hotTopicService.fetchTopics();
  });

  // 结合素材库生成选题建议
  safeHandle(ipc, 'hot-topics:suggest', async (_event, payload: unknown) => {
    const { topics } = (payload ?? {}) as { topics?: unknown };
    if (topics !== undefined && !Array.isArray(topics)) {
      throw new Error('hot-topics:suggest 入参无效:topics 必须为字符串数组');
    }
    const list = Array.isArray(topics) ? topics.filter((t): t is string => typeof t === 'string') : [];
    return hotTopicService.suggest(list);
  });

  // 选题一键生成口播脚本并落盘
  safeHandle(ipc, 'hot-topics:generateScript', async (_event, payload: unknown) => {
    const { topic } = payload as { topic: string };
    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      throw new Error('hot-topics:generateScript 入参缺失 topic');
    }
    const result = await hotTopicService.generateScript(topic);
    logger.info(`[IPC] hot-topics:generateScript 已生成脚本: ${result.path}`);
    return result;
  });
}

// 默认导出 register,便于 electron/ipc/index.ts 通过动态 import 加载
export default register;
