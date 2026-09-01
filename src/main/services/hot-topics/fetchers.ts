/**
 * 热榜抓取与解析(PRD-v1.7 数据飞轮与全景矩阵 FR-6)
 *
 * 职责:
 *   - 聚合多源热榜(百度热搜/微博热搜/抖音热点),单源超时 5s、失败隔离
 *   - 解析函数为纯函数(JSON → 话题列表),可独立单测
 *   - 跨源去重合并(小写归一后按文本去重)
 *
 * 风控与容错(沿用 model-downloader 经验):
 *   - 全部请求携带 Chrome User-Agent,默认跟随重定向
 *   - 任一源失败不影响其余;全部失败返回空数组,由上层提示"热点服务暂不可用"
 */
import { logger } from '../../utils/logger';

/** 热榜话题条目 */
export interface HotTopicSourceResult {
  /** 源名称 */
  source: string;
  /** 是否成功 */
  ok: boolean;
  /** 话题列表(成功时) */
  topics: string[];
}

/** Chrome UA(热榜接口拒绝无 UA 请求) */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 单源抓取超时(毫秒) */
export const TOPIC_FETCH_TIMEOUT_MS = 5000;

/**
 * 解析百度热搜板(https://top.baidu.com/api/board?platform=wise&tab=realtime)
 * 结构:data.cards[].content[].word
 * @param json 原始 JSON(未知形状)
 * @returns 话题标题列表
 */
export function parseBaiduHot(json: unknown): string[] {
  const topics: string[] = [];
  try {
    const data = (json as { data?: { cards?: { content?: { word?: unknown }[] }[] } }).data;
    const cards = data?.cards ?? [];
    for (const card of cards) {
      for (const item of card.content ?? []) {
        if (typeof item.word === 'string' && item.word.trim()) {
          topics.push(item.word.trim());
        }
      }
    }
  } catch {
    /* 容错:解析失败返回空 */
  }
  return topics;
}

/**
 * 解析微博热搜(https://weibo.com/ajax/side/hotSearch)
 * 结构:data.realtime[].word
 */
export function parseWeiboHot(json: unknown): string[] {
  const topics: string[] = [];
  try {
    const data = (json as { data?: { realtime?: { word?: unknown }[] } }).data;
    for (const item of data?.realtime ?? []) {
      if (typeof item.word === 'string' && item.word.trim()) {
        topics.push(item.word.trim());
      }
    }
  } catch {
    /* 容错 */
  }
  return topics;
}

/**
 * 解析抖音热点榜(https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/hot/)
 * 结构:data[].word(历史公开接口,可能失效,失败不影响整体)
 */
export function parseDouyinHot(json: unknown): string[] {
  const topics: string[] = [];
  try {
    const data = json as { data?: { word?: unknown }[] };
    for (const item of data?.data ?? []) {
      if (typeof item.word === 'string' && item.word.trim()) {
        topics.push(item.word.trim());
      }
    }
  } catch {
    /* 容错 */
  }
  return topics;
}

/**
 * 跨源去重合并(保持顺序;小写归一去重,保留首个原文)
 * @param lists 各源话题列表
 * @returns 合并后的话题列表
 */
export function dedupeTopics(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const t of list) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(t);
      }
    }
  }
  return merged;
}

/**
 * 抓取单个热榜源(带超时与 Chrome UA)
 * @param source 源名称(仅用于结果标注)
 * @param url 热榜接口 URL
 * @param parser 解析函数
 * @param fetchImpl fetch 实现(默认全局 fetch,测试可注入)
 * @returns 源抓取结果(失败时 ok=false topics=[])
 */
export async function fetchTopicSource(
  source: string,
  url: string,
  parser: (json: unknown) => string[],
  fetchImpl: typeof fetch = fetch,
): Promise<HotTopicSourceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOPIC_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json, text/plain, */*' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const json: unknown = await resp.json();
    const topics = parser(json);
    return { source, ok: true, topics };
  } catch (err) {
    logger.warn(
      `[hot-topics] 源 ${source} 抓取失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { source, ok: false, topics: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 热榜源定义 */
interface TopicSourceDef {
  source: string;
  url: string;
  parser: (json: unknown) => string[];
}

/** 内置热榜源 */
const TOPIC_SOURCES: TopicSourceDef[] = [
  {
    source: 'baidu',
    url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime',
    parser: parseBaiduHot,
  },
  {
    source: 'weibo',
    url: 'https://weibo.com/ajax/side/hotSearch',
    parser: parseWeiboHot,
  },
  {
    source: 'douyin',
    url: 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/hot/',
    parser: parseDouyinHot,
  },
];

/**
 * 聚合抓取全部热榜源(失败隔离,全失败时 topics 为空)
 * @param fetchImpl fetch 实现(测试可注入)
 * @returns { topics, sources }
 */
export async function fetchAllTopics(
  fetchImpl: typeof fetch = fetch,
): Promise<{ topics: string[]; sources: HotTopicSourceResult[] }> {
  const results = await Promise.all(
    TOPIC_SOURCES.map((s) => fetchTopicSource(s.source, s.url, s.parser, fetchImpl)),
  );
  const topics = dedupeTopics(...results.map((r) => r.topics));
  return { topics, sources: results };
}
