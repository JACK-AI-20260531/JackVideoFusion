/**
 * 语义匹配纯函数
 *
 * 职责:为"CLIP 视觉 + LLM 语义"双模态素材匹配提供可单测的纯逻辑,
 *       包括查询文本构造与双模态加权打分。
 *
 * 设计约定(对应方案 B「LLM 段落语义加权匹配」):
 *   - 纯函数,不依赖 electron / llmService / clip 实例,可独立单元测试
 *   - 语义向量的生成(embedText)在 material-matcher 中完成(属副作用),
 *     本文件只负责"关键词 → 查询文本"与"视觉分 + 语义分 → 加权总分"
 */

/**
 * 把 LLM 抽取的关键词数组拼接为单条查询文本
 * 用于后续 clip.embedText(查询文本)生成"段落语义向量"
 * @param keywords 关键词数组(可能为空)
 * @returns 拼接后的查询文本;关键词为空时返回空串
 */
export function buildSemanticQuery(keywords: string[]): string {
  if (!Array.isArray(keywords)) return '';
  const cleaned = keywords
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => k.length > 0);
  return cleaned.join(' ').trim();
}

/**
 * 双模态加权打分:综合"参考画面匹配分"与"段落语义匹配分"
 *
 *   finalScore = visualWeight * visualScore + (1 - visualWeight) * semanticScore
 *
 * 语义分缺省(如无关键词/未配置 LLM):
 *   - 若 parse 出 semanticScore 为 NaN,退化为纯 visualScore(visualWeight=1 效果)
 *
 * @param visualScore 参考画面与该候选帧的余弦相似度(0~1)
 * @param semanticScore 段落语义与该候选帧的余弦相似度(0~1);可为 NaN 表示无语义分
 * @param visualWeight 视觉分权重(0~1);越大越看重画面相似度
 * @returns 加权总分;visualScore 非法时返回 0
 */
export function scoreWithSemantic(
  visualScore: number,
  semanticScore: number,
  visualWeight: number,
): number {
  if (!Number.isFinite(visualScore)) return 0;

  // 语义分缺失 → 纯视觉
  if (!Number.isFinite(semanticScore)) {
    return Math.max(0, Math.min(1, visualScore));
  }

  const w = Math.max(0, Math.min(1, visualWeight));
  const v = Math.max(0, Math.min(1, visualScore));
  const s = Math.max(0, Math.min(1, semanticScore));
  return Math.max(0, Math.min(1, w * v + (1 - w) * s));
}
