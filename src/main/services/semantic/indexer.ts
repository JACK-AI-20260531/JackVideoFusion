/**
 * 语义索引建库(PRD-v2.1 FR-4)
 * 职责:遍历素材,未索引者 embedVideoFrame → 向量 + zero-shot 标签 → 落库
 * 设计要点:
 *  - 断点续建:已索引的 materialId 直接跳过
 *  - 单素材失败计入 failed 不中断;词向量缓存避免重复 embedText
 *  - 全部依赖注入(clip/存储/素材清单),可 node:test 单测
 */
import { getClipService } from '../clip';
import type { IClipService } from '../clip/types';
import type { IndexedMaterial } from './types';
import { argmaxTag } from './similarity';
import { TAG_GROUPS } from './tag-vocab';
import type { SemanticIndexStore } from './index-store';

/** 帧采样时刻(秒):取 1s 处,避开黑帧开头 */
export const FRAME_SAMPLE_SEC = 1;

/** 建库结果 */
export interface BuildResult {
  /** 本次新索引数 */
  built: number;
  /** 已索引跳过数 */
  skipped: number;
  /** 失败数 */
  failed: number;
}

/** buildSemanticIndex 依赖(默认 wiring 见 buildIndexWithDefaults) */
export interface BuildIndexDeps {
  /** 待索引素材列表(id/path/folderId/name) */
  materials: { id: string; path: string; folderId: string; name: string }[];
  /** CLIP 服务 */
  clip: Pick<IClipService, 'embedText' | 'embedVideoFrame'>;
  /** 索引存储 */
  store: Pick<SemanticIndexStore, 'get' | 'set'>;
  /** 进度回调(0-100) */
  onProgress?: (p: number) => void;
}

/**
 * 建库:逐素材生成向量与标签
 * 注意:词向量缓存独立于素材循环(每个词 embedText 一次)
 */
export async function buildSemanticIndex(deps: BuildIndexDeps): Promise<BuildResult> {
  const { materials, clip, store, onProgress } = deps;

  // 词向量缓存:全部词各 embedText 一次
  const termVectors = new Map<string, number[]>();
  for (const group of TAG_GROUPS) {
    for (const term of group.terms) {
      const vec = await clip.embedText(term);
      termVectors.set(term, Array.from(vec));
    }
  }

  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    if (store.get(m.id)) {
      skipped++;
      continue;
    }
    try {
      const frameVec = await clip.embedVideoFrame(m.path, FRAME_SAMPLE_SEC);
      const vector = Array.from(frameVec);
      const tags = argmaxTag(vector, TAG_GROUPS, termVectors);
      const entry: IndexedMaterial = {
        materialId: m.id,
        path: m.path,
        folderId: m.folderId,
        name: m.name,
        vector,
        tags,
        indexedAt: new Date().toISOString(),
      };
      store.set(entry);
      built++;
    } catch (err) {
      failed++;
      // 单素材失败不中断(错误信息由调用方日志记录)
      void err;
    }
    onProgress?.(Math.round(((i + 1) / materials.length) * 100));
  }
  return { built, skipped, failed };
}

/** 默认 wiring:真实 CLIP(懒加载)+ 注入的 store(供 IPC 调用) */
export async function buildIndexWithDefaults(
  materials: { id: string; path: string; folderId: string; name: string }[],
  store: Pick<SemanticIndexStore, 'get' | 'set'>,
  onProgress?: (p: number) => void,
): Promise<BuildResult> {
  const clip = await getClipService();
  return buildSemanticIndex({ materials, clip, store, onProgress });
}
