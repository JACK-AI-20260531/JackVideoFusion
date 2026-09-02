/**
 * 内容-分组匹配建议(PRD-v2.1 FR-7)
 * 职责:按「标题 bigram 相似度 0.6 + 分组历史互动率 0.4」加权,给出 Top-N 分组建议
 * 设计要点:
 *  - 纯函数,不依赖 electron/LLM,可 node:test 单测
 *  - 互动率归一化:min(平均互动率 / 0.2, 1),0.2 为经验满分互动率
 *  - LLM 解释文案由 IPC 编排层可选叠加,本模块不涉及
 */
import type { AnalyticsRecord } from '../auto-publish/analytics-store';
import type { MatrixGroup } from './types';

/** 标题相似度权重 */
export const TITLE_SIM_WEIGHT = 0.6;
/** 历史互动率权重 */
export const ENGAGEMENT_WEIGHT = 0.4;
/** 互动率归一化基准(平均互动率 0.2 记满分) */
export const ENGAGEMENT_RATE_NORM = 0.2;

/** 字符 bigram 集合构造 */
function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 字符 bigram Dice 相似度:2×|A∩B| / (|A|+|B|);任一串长度 <2 返回 0 */
export function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const denom = A.size + B.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

/** 分组建议项 */
export interface GroupSuggestion {
  groupId: string;
  name: string;
  score: number;
}

/**
 * 内容-分组匹配建议:按「标题相似度 + 历史互动率」加权排序
 * @param title 新作品标题
 * @param records 历史发布分析记录
 * @param groups 矩阵分组
 * @param topN 返回条数(默认 3)
 */
export function suggestGroups(
  title: string,
  records: AnalyticsRecord[],
  groups: MatrixGroup[],
  topN = 3,
): GroupSuggestion[] {
  const scored = groups.map((g) => {
    let simSum = 0;
    let simCount = 0;
    let rateSum = 0;
    let rateCount = 0;
    for (const r of records) {
      if (!g.platforms.includes(r.platform)) continue;
      simSum += bigramSimilarity(title, r.title);
      simCount++;
      const history = r.history ?? [];
      const latest = history.length > 0 ? history[history.length - 1] : undefined;
      if (latest && (latest.plays ?? 0) > 0) {
        rateSum += ((latest.likes ?? 0) + (latest.comments ?? 0)) / (latest.plays as number);
        rateCount++;
      }
    }
    const titleSim = simCount > 0 ? simSum / simCount : 0;
    const avgRate = rateCount > 0 ? rateSum / rateCount : 0;
    const engagementNorm = Math.min(avgRate / ENGAGEMENT_RATE_NORM, 1);
    return {
      groupId: g.id,
      name: g.name,
      score: TITLE_SIM_WEIGHT * titleSim + ENGAGEMENT_WEIGHT * engagementNorm,
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topN);
}
