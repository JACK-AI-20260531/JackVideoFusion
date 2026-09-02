/**
 * 素材语义服务 - 类型定义(PRD-v2.1 FR-4/5)
 * 职责:语义索引条目、搜索命中、重复分组、标签词表组
 */
/** 已索引素材条目 */
export interface IndexedMaterial {
  materialId: string;
  path: string;
  folderId: string;
  /** 文件名(展示用,与 path basename 一致) */
  name: string;
  /** CLIP 512 维 L2 归一化向量 */
  vector: number[];
  /** 自动标签(zero-shot argmax,每组一个) */
  tags: string[];
  indexedAt: string;
}

/** 搜索命中 */
export interface ScoredMaterial {
  materialId: string;
  path: string;
  folderId: string;
  name: string;
  score: number;
}

/** 语义重复组(组代表 + 冗余列表) */
export interface DuplicateGroup {
  materialId: string;
  path: string;
  folderId: string;
  duplicates: { materialId: string; path: string }[];
}

/** 标签词表组 */
export interface TagGroup {
  group: string;
  terms: string[];
}
