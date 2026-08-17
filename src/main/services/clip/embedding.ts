/**
 * CLIP 确定性嵌入纯函数
 * 职责:基于字符串生成确定性 L2 归一化嵌入向量,并提供余弦相似度计算
 *      纯数学函数,不依赖 electron/logger,可独立单元测试
 */
import { CLIP_EMBEDDING_DIM, type Embedding } from './types';

/**
 * 基于字符串生成确定性 L2 归一化的 512 维嵌入向量
 * 算法:对每个字符 charCode 累加位置加权的伪随机值,填充 512 维,再做 L2 归一化。
 * 保证:相同字符串 → 相同向量;不同字符串 → 不同向量(有区分度)。
 * @param input 输入字符串(文本/路径/路径+时间戳)
 * @returns 512 维 L2 归一化的 Float32Array
 */
export function deterministicEmbedding(input: string): Embedding {
  const dim = CLIP_EMBEDDING_DIM;
  const vec = new Float32Array(dim);

  // 空输入兜底:返回固定基向量,保证不出现零向量
  const src = input && input.length > 0 ? input : '\u0000';

  // 基于字符 charCode 与位置生成确定性填充
  // 使用线性同余式伪随机,种子里融合字符 charCode 与下标,确保不同输入产生差异化向量
  let seed = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < src.length; i++) {
    seed ^= src.charCodeAt(i);
    // FNV prime
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }

  for (let i = 0; i < dim; i++) {
    // 每个维度派生一个伪随机值
    seed = Math.imul(seed ^ (i + 0x9e3779b9), 0x85ebca6b) >>> 0;
    // 映射到 [-1, 1]
    vec[i] = (seed / 0xffffffff) * 2 - 1;
  }

  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

/**
 * 计算两个向量的余弦相似度
 * 向量已 L2 归一化时点积 = 余弦相似度,结果范围 [-1, 1]。
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度 [-1, 1]
 */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // 限制到 [-1, 1],规避浮点误差
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}
