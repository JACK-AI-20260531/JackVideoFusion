/**
 * 矩阵分组 IPC 注册(PRD-v2.1 FR-6/7)
 * 职责:将矩阵分组存储/聚合/建议能力暴露为 matrix:* 系列通道
 *
 * 通道列表:
 *   matrix-groups:save   - 保存分组(同名覆盖)
 *   matrix-groups:list   - 全量列表
 *   matrix-groups:delete - 按名称删除
 *   matrix:compare       - 按分组聚合近 N 天数据
 *   matrix:suggest       - 内容-分组匹配建议(可选 LLM 解释,失败降级)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { matrixGroupStore } from '../services/matrix/group-store';
import { aggregateByGroup } from '../services/matrix/matrix-dashboard';
import { suggestGroups } from '../services/matrix/suggest';
import type { MatrixGroup } from '../services/matrix/types';
import { analyticsStore } from '../services/auto-publish/analytics-store';
import { llmService } from '../services/llm';
import { logger } from '../utils/logger';

/**
 * 注册矩阵分组 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 保存分组(同名覆盖)
   * payload: { name: string, platforms: string[] }
   * 返回: MatrixGroup
   */
  safeHandle(ipc, 'matrix-groups:save', async (_event, payload) => {
    const p = payload as { name?: string; platforms?: string[] } | undefined;
    if (!p?.name || !Array.isArray(p.platforms)) {
      throw new Error('matrix-groups:save 参数无效:缺少 name/platforms');
    }
    return matrixGroupStore.save(p.name, JSON.parse(JSON.stringify(p.platforms)));
  });

  /** 全量列表(按更新时间降序) */
  safeHandle(ipc, 'matrix-groups:list', async () => matrixGroupStore.list());

  /**
   * 按名称删除分组
   * payload: { name: string }
   */
  safeHandle(ipc, 'matrix-groups:delete', async (_event, payload) => {
    const p = payload as { name?: string } | undefined;
    if (!p?.name) throw new Error('matrix-groups:delete 缺少 name');
    return matrixGroupStore.remove(p.name);
  });

  /**
   * 分组聚合(近 N 天,默认 7)
   * payload: { days?: number }
   * 返回: { groups: GroupAggregate[] }
   */
  safeHandle(ipc, 'matrix:compare', async (_event, payload) => {
    const p = payload as { days?: number } | undefined;
    const days = typeof p?.days === 'number' && [7, 30].includes(p.days) ? p.days : 7;
    const groups = matrixGroupStore.list();
    return {
      groups: aggregateByGroup(analyticsStore.list(), groups, days),
    };
  });

  /**
   * 内容-分组匹配建议(可选 LLM 解释,失败静默降级)
   * payload: { title: string, topN?: number, explain?: boolean }
   * 返回: { suggestions, explanation? }
   */
  safeHandle(ipc, 'matrix:suggest', async (_event, payload) => {
    const p = payload as { title?: string; topN?: number; explain?: boolean } | undefined;
    if (!p?.title || typeof p.title !== 'string') {
      throw new Error('matrix:suggest 参数无效:缺少 title');
    }
    const suggestions = suggestGroups(p.title, analyticsStore.list(), matrixGroupStore.list(), p.topN ?? 3);
    if (!p.explain) return { suggestions };

    // 可选 LLM 解释(温度 ≤0.3,JSON 容错,失败降级为纯建议)
    try {
      const prompt =
        `你是短视频矩阵运营助手。新作品标题:「${p.title}」。` +
        `候选分组的匹配分数(0-1):${JSON.stringify(suggestions)}。` +
        `请用不超过 60 字解释第一推荐为何适合这个作品。只输出 JSON:{"reason":"..."}`;
      const resp = await llmService.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 200,
      });
      let reason = resp.content ?? '';
      reason = reason.replace(/```json|```/g, '').trim();
      try {
        const parsed = JSON.parse(reason) as { reason?: string };
        if (parsed.reason) reason = parsed.reason;
      } catch {
        /* 非 JSON 直接使用原文 */
      }
      return { suggestions, explanation: reason };
    } catch (err) {
      logger.warn(
        `[matrix] LLM 解释失败(降级为纯建议): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { suggestions };
    }
  });
}
