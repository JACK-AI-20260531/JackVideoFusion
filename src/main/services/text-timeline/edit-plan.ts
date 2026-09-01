/**
 * 对话式编辑计划纯函数(PRD-文本即时间线 v2.0 FR-4 / M4)
 *
 * 职责:
 *   - 构造编辑计划 prompt(系统约束 + 片段上下文 + 用户指令)
 *   - LLM 原始输出 → 结构化计划(容错解析,沿用 PRD-爆款评分的降级思路)
 *   - 计划校验:丢弃非法 op,保留合法列表(dry-run 前置过滤)
 *
 * 设计要点:
 *   - LLM 温度 ≤0.3,只输出 JSON;不支持/有歧义时返回 clarification 反问,不猜
 *   - 时间轴一律为源素材秒;LLM 不提供精确区间时可用 segId 引用段落
 */
import type { EditOp, TextSegment } from './types';

/** 系统提示词:约束 LLM 只输出结构化编辑计划 */
export const EDIT_PLAN_SYSTEM = `你是视频剪辑助手。根据用户指令,基于给定的句级转写段落,生成一份视频编辑计划。
只输出 JSON,不要输出任何其他文字。输出格式二选一:
1. {"ops":[{"op":"cut","start":秒,"end":秒,"reason":"理由"}]} 或含 mute/move/retune
2. {"clarification":"当指令有歧义或缺少信息时,提出一个澄清问题"}
规则:
- op 取值:cut(删除)/ mute(静音)/ move(重排,srcStart/srcEnd/dstIndex)/ retune(param/value)
- start/end 为源素材时间轴的秒数(数字),必须落在素材时长内且 end>start
- 可用 segId 字段引用某个句子的完整区间,系统会自动转换
- cut 区间应覆盖完整句子边界,避免切在字中间
- 宁可反问澄清,也不要猜测含糊的指令`;

/**
 * 构造用户提示词:片段上下文 + 指令(纯函数)
 * @param instruction 用户自然语言指令
 * @param segments 句级段落
 * @param durationSec 源素材总时长(秒)
 * @returns 用户提示词
 */
export function buildEditPlanPrompt(
  instruction: string,
  segments: TextSegment[],
  durationSec: number,
): string {
  const lines: string[] = [`素材总时长:${durationSec.toFixed(2)} 秒`, '句级段落:'];
  for (const seg of segments) {
    lines.push(`- segId=${seg.id} [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s] ${seg.text}`);
  }
  lines.push(`用户指令:${instruction}`);
  return lines.join('\n');
}

/** 解析后的编辑计划 */
export interface ParsedEditPlan {
  /** 编辑操作列表(解析成功时) */
  ops?: EditOp[];
  /** 澄清反问(指令含糊时) */
  clarification?: string;
  /** 解析失败原因(诊断用) */
  parseError?: string;
}

/**
 * 剥离 markdown 围栏(容错解析第一步)
 * @param raw LLM 原始输出
 * @returns 剥离后的 JSON 文本
 */
export function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * 解析 LLM 原始输出为编辑计划(容错解析,纯函数)
 * 降级链:剥离围栏 → 整段 JSON 直解 → 截取第一个 {..} 对象
 * @param raw LLM 原始输出
 * @returns 解析结果(ops 或 clarification;全失败时 parseError)
 */
export function parseEditPlan(raw: string): ParsedEditPlan {
  if (!raw || typeof raw !== 'string') {
    return { parseError: 'LLM 输出为空' };
  }
  const candidates = [stripFences(raw)];
  const braceIndex = stripFences(raw).indexOf('{');
  if (braceIndex > 0) {
    candidates.push(stripFences(raw).slice(braceIndex));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        ops?: unknown;
        clarification?: unknown;
      };
      if (typeof parsed.clarification === 'string' && parsed.clarification.trim().length > 0) {
        return { clarification: parsed.clarification.trim() };
      }
      if (Array.isArray(parsed.ops)) {
        return { ops: parsed.ops as EditOp[] };
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return { parseError: 'LLM 输出无法解析为编辑计划' };
}

/**
 * 计划校验:过滤非法 op(dry-run 前置,纯函数)
 * 规则:
 *   - cut/mute:start/end 必须为有限数值且 end>start(越界由 EDL 层钳制)
 *   - move:srcStart/srcEnd/dstIndex 数值合法;区间倒置丢弃
 *   - retune:param/value 必须为非空字符串
 *   - 支持 segId 引用:op 带合法 segId 时,用段落区间覆盖 start/end
 * @param ops 原始 op 列表
 * @param segments 句级段落(segId 解析用)
 * @param durationSec 源素材总时长
 * @returns 合法 op 列表
 */
export function sanitizeEditPlan(
  ops: EditOp[],
  segments: TextSegment[],
  durationSec: number,
): EditOp[] {
  const segMap = new Map(segments.map((s) => [s.id, s]));
  const result: EditOp[] = [];
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as EditOp & { segId?: unknown };
    // segId 引用:用段落区间补全 start/end
    let start = (op as unknown as { start?: unknown }).start;
    let end = (op as unknown as { end?: unknown }).end;
    if (typeof op.segId === 'string' && segMap.has(op.segId)) {
      const seg = segMap.get(op.segId) as TextSegment;
      start = seg.start;
      end = seg.end;
    }
    if (op.op === 'cut' || op.op === 'mute') {
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const clampedEnd = Math.min(end, durationSec);
      if (clampedEnd <= start) continue;
      result.push(
        op.op === 'cut'
          ? { op: 'cut', start, end: clampedEnd, reason: op.reason }
          : { op: 'mute', start, end: clampedEnd, reason: op.reason },
      );
    } else if (op.op === 'move') {
      const { srcStart, srcEnd, dstIndex } = op as unknown as {
        srcStart?: unknown;
        srcEnd?: unknown;
        dstIndex?: unknown;
      };
      if (
        typeof srcStart !== 'number' ||
        typeof srcEnd !== 'number' ||
        typeof dstIndex !== 'number' ||
        !Number.isFinite(srcStart) ||
        !Number.isFinite(srcEnd) ||
        srcEnd <= srcStart
      ) {
        continue;
      }
      result.push({
        op: 'move',
        srcStart,
        srcEnd,
        dstIndex: Math.max(0, Math.floor(dstIndex)),
        reason: op.reason,
      });
    } else if (op.op === 'retune') {
      const { param, value } = op as unknown as { param?: unknown; value?: unknown };
      if (typeof param === 'string' && param.trim().length > 0 && typeof value === 'string') {
        result.push({ op: 'retune', param, value, reason: op.reason });
      }
    }
  }
  return result;
}
