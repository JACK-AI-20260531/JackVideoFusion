/**
 * 语义相似度纯函数(PRD-v2.1 FR-4/5)
 * 职责:余弦、Top-K 过滤、zero-shot 标签 argmax、语义重复分组
 * 设计要点:全部不依赖 electron/CLIP 实例,可 node:test 单测
 */
import type {
  DuplicateGroup,
  IndexedMaterial,
  ScoredMaterial,
  TagGroup,
} from './types';

/** 搜索相似度默认阈值 */
export const DEFAULT_SEARCH_THRESHOLD = 0.25;
/** 语义重复默认阈值(余弦) */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

/** 余弦相似度(零向量返回 0 不抛错) */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Top-K:过滤低于阈值 → 按分数降序 → 截断 k 条 */
export function topK(
  items: ScoredMaterial[],
  k: number,
  threshold: number = DEFAULT_SEARCH_THRESHOLD,
): ScoredMaterial[] {
  return items
    .filter((it) => it.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * zero-shot 标签:每组词取与帧向量相似度最高的词
 * @param frame 素材帧向量
 * @param vocab 标签词表(多组)
 * @param termVectors 词向量缓存(词 → 向量;缺失词跳过)
 * @returns 每组一个标签(组内无可比词则跳过该组)
 */
export function argmaxTag(
  frame: number[],
  vocab: TagGroup[],
  termVectors: Map<string, number[]>,
): string[] {
  const tags: string[] = [];
  for (const group of vocab) {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const term of group.terms) {
      const vec = termVectors.get(term);
      if (!vec) continue;
      const score = cosine(frame, vec);
      if (score > bestScore) {
        bestScore = score;
        best = term;
      }
    }
    if (best) tags.push(best);
  }
  return tags;
}

/**
 * 语义重复分组:两两余弦 ≥ threshold 视为近重复
 * 返回每个组代表(先出现者)与其冗余列表;独立素材不成组
 */
export function findDuplicateGroups(
  entries: IndexedMaterial[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): DuplicateGroup[] {
  const used = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(entries[i].materialId)) continue;
    const duplicates: { materialId: string; path: string }[] = [];
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(entries[j].materialId)) continue;
      if (cosine(entries[i].vector, entries[j].vector) >= threshold) {
        duplicates.push({ materialId: entries[j].materialId, path: entries[j].path });
        used.add(entries[j].materialId);
      }
    }
    if (duplicates.length > 0) {
      used.add(entries[i].materialId);
      groups.push({
        materialId: entries[i].materialId,
        path: entries[i].path,
        folderId: entries[i].folderId,
        duplicates,
      });
    }
  }
  return groups;
}
