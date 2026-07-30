/**
 * CLIP Mock 引擎
 *
 * 职责:在 onnxruntime-node 不可用或模型权重缺失时,提供确定性伪向量实现,
 *       保证"接口跑通、相同输入相同输出、余弦相似度有区分度"。
 *
 * 实现要点:
 *   - 基于输入字符串生成确定性 512 维 Float32Array(字符 charCode 累加 + 位置权重)
 *   - L2 归一化,使点积 = 余弦相似度
 *   - 不依赖任何 native binding,纯 TypeScript 计算
 */
import { logger } from '../../utils/logger';
import { CLIP_EMBEDDING_DIM, type Embedding, type IClipService, type MatchCandidate, type MatchResult } from './types';

/**
 * 基于字符串生成确定性 L2 归一化的 512 维嵌入向量
 * 算法:对每个字符 charCode 累加位置加权的伪随机值,填充 512 维,再做 L2 归一化。
 * 保证:相同字符串 → 相同向量;不同字符串 → 不同向量(有区分度)。
 * @param input 输入字符串(文本/路径/路径+时间戳)
 * @returns 512 维 L2 归一化的 Float32Array
 */
function deterministicEmbedding(input: string): Embedding {
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
 * CLIP Mock 引擎实现
 * 实现完整 IClipService 接口,但所有嵌入均由确定性伪向量算法生成。
 */
export class MockClipEngine implements IClipService {
  /** 是否已加载真实模型(否则为 mock) */
  public readonly isRealModel = false;

  /**
   * 加载模型 — Mock 引擎空操作,仅记录日志
   */
  public async loadModel(): Promise<void> {
    logger.info('[CLIP] 使用 Mock 引擎(无需加载模型,伪向量直接生成)');
  }

  /**
   * 文本 → 嵌入向量
   * @param text 输入文本
   * @returns 512 维 L2 归一化向量
   */
  public async embedText(text: string): Promise<Embedding> {
    return deterministicEmbedding(`text::${text ?? ''}`);
  }

  /**
   * 图像文件 → 嵌入向量
   * Mock 模式下不读取真实像素,基于路径字符串生成确定性向量。
   * @param imagePath 图像文件路径
   * @returns 512 维 L2 归一化向量
   */
  public async embedImage(imagePath: string): Promise<Embedding> {
    return deterministicEmbedding(`image::${imagePath ?? ''}`);
  }

  /**
   * 视频某时间点抽帧 → 嵌入向量
   * Mock 模式下不真正抽帧,基于"路径+时间戳"生成确定性向量。
   * @param videoPath 视频文件路径
   * @param timeSec 抽帧时间点(秒)
   * @returns 512 维 L2 归一化向量
   */
  public async embedVideoFrame(videoPath: string, timeSec: number): Promise<Embedding> {
    return deterministicEmbedding(`frame::${videoPath ?? ''}@${Number(timeSec) || 0}`);
  }

  /**
   * 计算两个向量的余弦相似度
   * 向量已 L2 归一化,点积 = 余弦相似度,结果范围 [-1, 1]。
   * @param a 向量 A
   * @param b 向量 B
   * @returns 余弦相似度
   */
  public cosineSimilarity(a: Embedding, b: Embedding): number {
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

  /**
   * 批量匹配:文本 vs 多个候选项,按分数降序返回
   * 内部直接调用同步的 deterministicEmbedding 生成文本向量,再与候选项计算点积。
   * @param text 查询文本
   * @param candidates 候选项列表(id + 嵌入向量)
   * @returns 按相似度降序的匹配结果
   */
  public match(
    text: string,
    candidates: MatchCandidate[],
  ): MatchResult[] {
    const textVec = deterministicEmbedding(`text::${text ?? ''}`);
    const results: MatchResult[] = candidates.map((c) => ({
      id: c.id,
      score: this.cosineSimilarity(textVec, c.embedding),
    }));
    results.sort((x, y) => y.score - x.score);
    return results;
  }
}
