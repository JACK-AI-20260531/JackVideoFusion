/**
 * 发布文案 AI 助手:平台风格常量、prompt 组装与 LLM 返回容错解析(PRD-v2.2 FR-1)
 * 职责:五平台风格常量表、系统/用户提示词构造、JSON 容错解析与字段校验降级
 *      纯函数,不依赖 electron/llm 服务,可独立单元测试;
 *      llm 调用与编排由 index.ts 服务层接入
 */
import type { ChatMessage } from '../llm';
import type { PublishPlatform } from '../auto-publish/types';

/** 单平台风格定义(PRD-v2.2 FR-1.1) */
export interface PlatformStyle {
  /** 平台中文名 */
  label: string;
  /** 风格要点(喂给 LLM) */
  styleHint: string;
  /** 标题字数建议 [min, max] */
  titleRange: [number, number];
  /** 话题标签建议数量区间 [min, max] */
  tagCount: [number, number];
}

/** 五平台风格常量表:新增平台只加常量,不改逻辑 */
export const PLATFORM_STYLE: Record<PublishPlatform, PlatformStyle> = {
  douyin: {
    label: '抖音',
    styleHint: '强钩子口语化,前 3 秒抓人,多用悬念与反差,避免书面语',
    titleRange: [10, 20],
    tagCount: [3, 5],
  },
  kuaishou: {
    label: '快手',
    styleHint: '真实接地气,老铁语境,直白有温度,不过度包装',
    titleRange: [10, 20],
    tagCount: [3, 5],
  },
  xiaohongshu: {
    label: '小红书',
    styleHint: '种草体,适度 emoji 点缀,场景化痛点描述,像朋友分享',
    titleRange: [12, 24],
    tagCount: [4, 8],
  },
  bilibili: {
    label: 'B站',
    styleHint: '信息量与分区调性并重,可用轻度玩梗,标题交代清楚看点',
    titleRange: [15, 30],
    tagCount: [3, 6],
  },
  shipinhao: {
    label: '视频号',
    styleHint: '温和大众向,正能量或实用价值导向,措辞稳妥',
    titleRange: [10, 22],
    tagCount: [3, 5],
  },
};

/** 文案生成结果(PRD-v2.2 FR-1.2) */
export interface Copywriting {
  /** 3 个候选标题 */
  titles: string[];
  /** 视频描述 */
  description: string;
  /** 话题标签(去 # 去重后 3-8 个) */
  tags: string[];
}

/** 文案系统提示词:仅输出 JSON 对象,便于程序解析 */
export const COPYWRITING_SYSTEM = `你是一名资深短视频运营专家。你的任务是根据用户给出的视频标题/主题,为指定平台生成发布文案。
输出要求:
1. titles:恰好 3 个候选标题,符合该平台风格与字数习惯,彼此风格有区分(如悬念式/数字式/痛点式)。
2. description:一段 40-100 字的视频描述,贴合平台调性。
3. tags:话题标签,不带 # 号,数量符合该平台习惯。
4. 仅输出 JSON 对象,不要输出任何解释、围栏或多余文字。格式:
{"titles":["...","...","..."],"description":"...","tags":["..."]}`;

/**
 * 构造文案生成的消息列表(system + user)
 * @param title 用户输入的视频标题/主题/草稿
 * @param platform 目标平台(决定风格要点)
 * @returns 消息列表
 */
export function buildCopyPrompt(title: string, platform: PublishPlatform): ChatMessage[] {
  const style = PLATFORM_STYLE[platform];
  const user = `视频标题/主题:${title}
目标平台:${style.label}(${platform})
平台风格要求:${style.styleHint}
标题字数:${style.titleRange[0]}-${style.titleRange[1]} 字;话题标签:${style.tagCount[0]}-${style.tagCount[1]} 个。

请按系统提示词要求的 JSON 对象格式输出文案。`;
  return [
    { role: 'system', content: COPYWRITING_SYSTEM },
    { role: 'user', content: user },
  ];
}

/**
 * 从 LLM 原始输出中截取首个 JSON 对象文本(兼容 ```json 围栏与前后杂质)
 * @param raw 原始输出
 * @returns JSON 文本;找不到成对花括号时返回 null
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 标签数量上限(截断防超长) */
export const MAX_TAGS = 8;

/**
 * 解析 LLM 文案输出(容错:剥围栏 → 整段直解 → 截取对象)
 * @param raw LLM 原始输出
 * @returns 文案结果;缺关键字段(无有效标题)时返回 null 由调用方降级
 */
export function parseCopyResponse(raw: string): Copywriting | null {
  if (!raw || typeof raw !== 'string') return null;
  // 剥离 markdown 围栏(```json ... ```)
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  let obj: unknown = null;
  try {
    obj = JSON.parse(stripped);
  } catch {
    const jsonText = extractJsonObject(stripped);
    if (!jsonText) return null;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;

  // titles:字符串数组,过滤空串,截断 3 个
  const titles = Array.isArray(rec.titles)
    ? rec.titles.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 3)
    : [];
  if (titles.length === 0) return null;

  // description:非字符串回退空串
  const description = typeof rec.description === 'string' ? rec.description.trim() : '';

  // tags:归一化(去 #、去空、去重、截断)
  const seen = new Set<string>();
  const tags: string[] = [];
  if (Array.isArray(rec.tags)) {
    for (const t of rec.tags) {
      if (typeof t !== 'string') continue;
      const norm = t.trim().replace(/^#+/, '').trim();
      if (norm.length === 0 || seen.has(norm)) continue;
      seen.add(norm);
      tags.push(norm);
      if (tags.length >= MAX_TAGS) break;
    }
  }

  return { titles, description, tags };
}
