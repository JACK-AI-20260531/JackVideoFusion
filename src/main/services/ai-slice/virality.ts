/**
 * 爆款评分:批量 prompt 组装与 LLM 返回容错解析(PRD-爆款评分与智能分发 FR-1/FR-3)
 * 职责:系统提示词、批量用户消息构造、截断摘要、JSON 容错解析与字段校验降级
 *      纯函数,不依赖 electron/llm 服务,可独立单元测试;
 *      llm 调用与编排由后续版本的服务层接入
 */
import type { ViralityReport, ViralitySubScores } from './types';
import { gradeOf } from './score';

/** 爆款评分系统提示词:仅输出 JSON 数组,便于程序解析 */
export const VIRALITY_SYSTEM = `你是一名短视频爆款分析师。你的任务是对给定的若干视频切片逐一评估其"爆款潜力"。
评估要求:
1. 从五个维度打分(0-100 整数):hook(前 3 秒钩子强度)、emotion(情绪强度)、topic(话题性)、retention(完播潜力)、titleability(标题潜力)。
2. 综合分按权重计算:钩子 0.25 + 情绪 0.2 + 话题 0.25 + 完播 0.2 + 标题 0.1。
3. 每条切片必须输出 1-3 条评分理由和 0-2 条改进建议,理由要具体引用切片内容。
4. 顺带生成分平台风格的候选标题(最多 5 条)、话题标签(最多 8 条,以 # 开头)、封面文案(最多 3 条)。
5. 仅输出 JSON 数组,不要输出任何解释或多余文字。每个元素格式:
{"index":1,"sub":{"hook":80,"emotion":70,"topic":85,"retention":75,"titleability":80},"reasons":["..."],"suggestions":["..."],"titles":["..."],"tags":["#xx"],"coverText":["..."]}`;

/** 参与批量评分的单个切片输入(文本摘要 + 元信息) */
export interface ClipScoreInput {
  /** 切片索引(从 1 开始,须与切片结果一致) */
  index: number;
  /** 切片时长(秒) */
  durationSec: number;
  /** 切片转写文本(超长会被截断) */
  transcript: string;
}

/** 五维子分键名 */
const SUB_KEYS = ['hook', 'emotion', 'topic', 'retention', 'titleability'] as const;
type SubKey = (typeof SUB_KEYS)[number];

/** 五维权重(PRD FR-1) */
const SUB_WEIGHTS: Record<SubKey, number> = {
  hook: 0.25,
  emotion: 0.2,
  topic: 0.25,
  retention: 0.2,
  titleability: 0.1,
};

/** 各字符串数组字段长度上限 */
const ARRAY_LIMITS = { reasons: 3, suggestions: 2, titles: 5, tags: 8, coverText: 3 } as const;

/**
 * 截断转写文本为摘要(prompt 只传摘要,控制 token 成本)
 * @param text 原始转写文本
 * @param maxLen 最大长度(默认 200 字符)
 * @returns 截断后的文本,超长以省略号结尾
 */
export function truncateTranscript(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

/**
 * 构造批量评分的用户消息
 * @param clips 切片摘要列表
 * @param maxTranscriptLen 单条转写最大长度(默认 200)
 * @returns 用户消息内容
 */
export function buildViralityPrompt(
  clips: ClipScoreInput[],
  maxTranscriptLen = 200,
): string {
  const lines = clips.map((c) => {
    const transcript = truncateTranscript(c.transcript, maxTranscriptLen);
    return `切片 ${c.index}(时长 ${Math.round(c.durationSec)} 秒):
${transcript || '(无语音内容)'}`;
  });
  return `请对以下 ${clips.length} 条切片逐一评估爆款潜力。

${lines.join('\n\n')}

请按系统提示词要求的 JSON 数组格式输出每条切片的评分。`;
}

/**
 * 由五维子分计算综合分(加权求和,四舍五入到整数)
 * @param sub 五维子分(0-100)
 * @returns 综合爆款分(0-100)
 */
export function computeViralityScore(sub: ViralitySubScores): number {
  const total = SUB_KEYS.reduce((sum, key) => sum + SUB_WEIGHTS[key] * sub[key], 0);
  return Math.round(Math.min(100, Math.max(0, total)));
}

/** 把未知值收敛为 0-100 整数,非法值返回 null */
function toScore100(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** 把未知值收敛为非空字符串数组,截断到 max 条 */
function toStrArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, max);
}

/**
 * 从 LLM 原始输出中提取 JSON 数组(容错:整段直解 → 剥离围栏提取 → 兼容单对象)
 * @param raw LLM 原始输出
 * @returns 解析出的条目数组;无法解析时返回空数组
 */
function extractEntries(raw: string): unknown[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  // 1. 整段即合法 JSON(数组或单对象)
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // 继续尝试从混杂文本中截取
  }
  // 2. 截取最外层 JSON 数组(如"结果如下: [...] 以上")
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试单对象
    }
  }
  // 3. 截取单对象(避免取到对象内部更靠前的 '[')
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      // 无法解析
    }
  }
  return [];
}

/**
 * 容错解析 LLM 返回的爆款评分结果(FR-3 失败隔离)
 * 规则:index 非法跳过;sub 完整时按权重重算综合分;
 *      sub 缺失但 score 合法时五维子分统一取 score;均缺失跳过该条
 * @param raw LLM 原始输出
 * @returns 切片索引 → 爆款评分报告(仅含合法条目)
 */
export function parseViralityReports(raw: string): Record<number, ViralityReport> {
  const entries = extractEntries(raw);
  const reports: Record<number, ViralityReport> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const index = typeof obj.index === 'number' ? Math.floor(obj.index) : NaN;
    if (!Number.isInteger(index) || index < 1) continue;

    const rawSub = (obj.sub && typeof obj.sub === 'object' ? obj.sub : null) as
      | Record<string, unknown>
      | null;
    let sub: ViralitySubScores | null = null;
    let score: number | null = null;
    if (rawSub) {
      const collected = SUB_KEYS.map((k) => toScore100(rawSub[k]));
      if (collected.every((v) => v !== null)) {
        sub = Object.fromEntries(
          SUB_KEYS.map((k, i) => [k, collected[i]]),
        ) as unknown as ViralitySubScores;
        score = computeViralityScore(sub);
      }
    }
    if (sub === null || score === null) {
      score = toScore100(obj.score);
      if (score === null) continue;
      sub = { hook: score, emotion: score, topic: score, retention: score, titleability: score };
    }

    reports[index] = {
      score,
      grade: gradeOf(score),
      sub,
      reasons: toStrArray(obj.reasons, ARRAY_LIMITS.reasons),
      suggestions: toStrArray(obj.suggestions, ARRAY_LIMITS.suggestions),
      titles: toStrArray(obj.titles, ARRAY_LIMITS.titles),
      tags: toStrArray(obj.tags, ARRAY_LIMITS.tags),
      coverText: toStrArray(obj.coverText, ARRAY_LIMITS.coverText),
      source: 'llm',
    };
  }
  return reports;
}
