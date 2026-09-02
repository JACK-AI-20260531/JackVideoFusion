/**
 * 语义搜索(PRD-v2.1 FR-4)
 * 职责:查询文本 → CLIP 文本向量 → 与索引全量算余弦 → Top-K + 阈值
 * 设计要点:向量已 L2 归一化,余弦=点积;全部依赖注入可单测
 */
import type { IClipService } from '../clip/types';
import type { IndexedMaterial, ScoredMaterial } from './types';
import { cosine, topK, DEFAULT_SEARCH_THRESHOLD } from './similarity';

/** 搜索依赖 */
export interface SearchDeps {
  /** CLIP 服务(仅用 embedText) */
  clip: Pick<IClipService, 'embedText'>;
  /** 索引存储 */
  store: { list: () => IndexedMaterial[] };
  /** 返回条数(默认 20) */
  topK?: number;
  /** 相似度阈值(默认 0.25) */
  threshold?: number;
}

/**
 * 语义搜索
 * @param query 自然语言查询(非空,首尾空白容忍)
 * @returns 按相似度降序的命中列表
 */
export async function semanticSearch(query: string, deps: SearchDeps): Promise<ScoredMaterial[]> {
  const text = query.trim();
  if (!text) throw new Error('语义搜索:查询文本不能为空');
  const k = deps.topK ?? 20;
  const threshold = deps.threshold ?? DEFAULT_SEARCH_THRESHOLD;
  const queryVec = await deps.clip.embedText(text);
  const hits: ScoredMaterial[] = deps.store.list().map((entry) => ({
    materialId: entry.materialId,
    path: entry.path,
    folderId: entry.folderId,
    name: entry.name,
    score: cosine(Array.from(queryVec), entry.vector),
    tags: entry.tags ?? [],
  }));
  return topK(hits, k, threshold);
}

/** 标签计数条目 */
export interface TagCount {
  tag: string;
  count: number;
}

/**
 * 聚合索引条目的自动标签词表(按出现次数降序,次数相同按字典序)
 * @param entries 索引条目(兼容旧条目 tags 缺省)
 * @returns 标签计数列表
 */
export function aggregateTags(entries: { tags?: string[] }[]): TagCount[] {
  const counter = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      if (typeof t !== 'string' || t.trim().length === 0) continue;
      counter.set(t, (counter.get(t) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
