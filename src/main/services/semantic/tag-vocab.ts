/**
 * 语义自动标签词表(PRD-v2.1 FR-4)
 * zero-shot:每组 embedText 一次,素材帧向量与词向量取 argmax
 * 词表可按用户群扩展,保持每组内词义互斥
 */
import type { TagGroup } from './types';

/** 标签词表(3 组,每组内词义互斥) */
export const TAG_GROUPS: TagGroup[] = [
  { group: '场景', terms: ['室内', '户外', '城市', '自然风景', '海边', '夜景'] },
  { group: '主体', terms: ['人物', '动物', '产品', '食物', '建筑', '文字图表'] },
  { group: '风格', terms: ['实拍', '动画', '屏幕录制', '图文'] },
];
