/**
 * 素材语义索引 IPC 注册(PRD-v2.1 FR-4/5)
 * 职责:将 semantic 服务能力暴露为 semantic:* 系列通道
 *
 * 通道列表:
 *   semantic:build      - 后台建库(断点续建,进度入任务中心)
 *   semantic:status     - { total, indexed }
 *   semantic:search     - 自然语言搜索 Top-K
 *   semantic:remove     - 移除单素材索引
 *   semantic:dupes      - 语义查重(重复分组)
 *   semantic:removeMany - 批量移除索引(查重清理)
 *   semantic:listTags   - 自动标签词表聚合(前端筛选下拉)
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc/index';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import { semanticIndexStore } from '../services/semantic/index-store';
import { buildIndexWithDefaults } from '../services/semantic/indexer';
import { semanticSearch, aggregateTags } from '../services/semantic/search';
import { findDuplicateGroups, DEFAULT_DUPLICATE_THRESHOLD } from '../services/semantic/similarity';
import { materialRepo } from '../services/material-repo';
import { getClipService } from '../services/clip';
import { logger } from '../utils/logger';

/** 建库任务是否进行中(防重复触发) */
let building = false;

/**
 * 注册素材语义 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 后台建库(断点续建,已索引素材自动跳过)
   * 返回: { started: true }
   */
  safeHandle(ipc, 'semantic:build', async () => {
    if (building) return { started: true };
    building = true;
    const taskId = `semantic-${Date.now().toString(36)}`;
    const task: TaskItem = {
      id: taskId,
      type: 'semantic-index',
      title: '素材语义索引',
      status: 'pending',
      progress: 0,
      params: {},
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 后台执行:遍历全部文件夹素材
    void (async () => {
      try {
        const folders = materialRepo.listFolders();
        const materials = folders.flatMap((f) =>
          materialRepo.listMaterials(f.id).map((m) => ({
            id: m.id,
            path: m.path,
            folderId: m.folderId,
            name: m.name,
          })),
        );
        const res = await buildIndexWithDefaults(materials, semanticIndexStore, (p) =>
          taskQueue.updateProgress(taskId, p),
        );
        taskQueue.complete(taskId);
        logger.info(
          `[semantic] 建库完成: 新建 ${res.built},跳过 ${res.skipped},失败 ${res.failed}`,
        );
      } catch (err) {
        taskQueue.fail(taskId, err instanceof Error ? err.message : String(err));
      } finally {
        building = false;
      }
    })();

    return { started: true };
  });

  /**
   * 索引状态(素材总数 vs 已索引数)
   * 返回: { total, indexed }
   */
  safeHandle(ipc, 'semantic:status', async () => {
    const folders = materialRepo.listFolders();
    let total = 0;
    for (const f of folders) total += materialRepo.listMaterials(f.id).length;
    return { total, indexed: semanticIndexStore.size() };
  });

  /**
   * 自然语言搜索
   * payload: { text: string, topK?: number, threshold?: number }
   * 返回: ScoredMaterial[](按相似度降序)
   */
  safeHandle(ipc, 'semantic:search', async (_event, payload) => {
    const p = payload as { text?: string; topK?: number; threshold?: number } | undefined;
    if (!p?.text || typeof p.text !== 'string') {
      throw new Error('semantic:search 参数无效:缺少 text');
    }
    const clip = await getClipService();
    return semanticSearch(p.text, {
      clip,
      store: semanticIndexStore,
      topK: typeof p.topK === 'number' && p.topK > 0 ? p.topK : undefined,
      threshold: typeof p.threshold === 'number' ? p.threshold : undefined,
    });
  });

  /**
   * 移除单素材索引(素材删除时同步)
   * payload: { materialId: string }
   */
  safeHandle(ipc, 'semantic:remove', async (_event, payload) => {
    const p = payload as { materialId?: string } | undefined;
    if (!p?.materialId) throw new Error('semantic:remove 缺少 materialId');
    semanticIndexStore.remove(p.materialId);
    return true;
  });

  /**
   * 语义查重:索引向量两两余弦 ≥ 阈值的重复分组
   * payload: { threshold?: number }
   * 返回: DuplicateGroup[](每组:代表 + 冗余列表)
   */
  safeHandle(ipc, 'semantic:dupes', async (_event, payload) => {
    const p = payload as { threshold?: number } | undefined;
    const threshold = typeof p?.threshold === 'number' && p.threshold > 0 && p.threshold < 1
      ? p.threshold
      : DEFAULT_DUPLICATE_THRESHOLD;
    return findDuplicateGroups(semanticIndexStore.list(), threshold);
  });

  /**
   * 批量移除索引(查重清理冗余用)
   * payload: { materialIds: string[] }
   * 返回: { removed: number }
   */
  safeHandle(ipc, 'semantic:removeMany', async (_event, payload) => {
    const p = payload as { materialIds?: string[] } | undefined;
    if (!Array.isArray(p?.materialIds) || p.materialIds.length === 0) {
      throw new Error('semantic:removeMany 参数无效:materialIds 不能为空');
    }
    let removed = 0;
    for (const id of p.materialIds) {
      if (typeof id === 'string') {
        semanticIndexStore.remove(id);
        removed++;
      }
    }
    return { removed };
  });

  /**
   * 自动标签词表(全索引聚合,按次数降序;PRD-v2.2 FR-5)
   * 返回: { tag, count }[]
   */
  safeHandle(ipc, 'semantic:listTags', async () => aggregateTags(semanticIndexStore.list()));
}
