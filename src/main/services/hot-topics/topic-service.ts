/**
 * 热点选题编排服务(PRD-v1.7 数据飞轮与全景矩阵 FR-6)
 *
 * 职责:
 *   - 聚合热榜 → LLM 结合素材库生成选题建议(标题+切入角度+适配标签)
 *   - 选题一键生成口播脚本并落盘(userData/hot-topics/scripts/),为 v2.0 文本即时间线铺垫
 *
 * 约定:LLM 温度 ≤0.3,仅输出 JSON 并做容错解析(剥离围栏 → 截取数组),缺失字段降级不抛错
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { llmService } from '../llm';
import type { ChatMessage } from '../llm';
import { materialRepo } from '../material-repo';
import { logger } from '../../utils/logger';
import { fetchAllTopics } from './fetchers';
import type { HotTopicSourceResult } from './fetchers';

/** 单条选题建议 */
export interface TopicSuggestion {
  /** 选题标题 */
  title: string;
  /** 切入角度 */
  angle: string;
  /** 适配素材标签 */
  tags: string[];
}

/** 素材库系统提示词:仅输出 JSON 数组 */
const SUGGEST_SYSTEM = `你是短视频选题策划师。根据给定的热榜话题与创作者素材库信息,输出 5 条选题建议。
要求:
1. 每条选题包含 title(吸睛标题)、angle(切入角度,一句话)、tags(适配的素材标签,最多 3 条,以 # 开头)。
2. 选题必须可由创作者现有素材方向承接,不要凭空虚构需要专业拍摄的题材。
3. 仅输出 JSON 数组,格式:
[{"title":"...","angle":"...","tags":["#xx"]}]`;

/**
 * 容错解析 LLM 返回的选题建议(剥离围栏 → 截取 JSON 数组)
 * @param raw LLM 原始输出
 * @returns 选题建议列表(非法条目跳过)
 */
export function parseSuggestions(raw: string): TopicSuggestion[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  let entries: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        /* 解析失败返回空 */
      }
    }
  }
  const suggestions: TopicSuggestion[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) continue;
    suggestions.push({
      title,
      angle: typeof obj.angle === 'string' ? obj.angle.trim() : '',
      tags: Array.isArray(obj.tags)
        ? obj.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 3)
        : [],
    });
  }
  return suggestions.slice(0, 5);
}

/**
 * 热点选题编排器
 */
export class HotTopicService {
  /**
   * 聚合抓取热榜(全失败时 topics 为空,由上层提示)
   */
  async fetchTopics(): Promise<{ topics: string[]; sources: HotTopicSourceResult[] }> {
    return fetchAllTopics();
  }

  /**
   * 结合素材库生成选题建议
   * @param topics 热榜话题列表(为空时用兜底提示;不阻断)
   * @returns 选题建议列表
   */
  async suggest(topics: string[]): Promise<{ suggestions: TopicSuggestion[]; topicCount: number }> {
    const folderNames = materialRepo.listFolders().map((f) => f.name);
    const topicList = topics.length > 0 ? topics : ['(热榜暂不可用,请基于创作者素材方向自由发挥)'];
    const messages: ChatMessage[] = [
      { role: 'system', content: SUGGEST_SYSTEM },
      {
        role: 'user',
        content: `热榜话题(按热度排序):\n${topicList.slice(0, 30).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n创作者素材库文件夹(素材方向参考):\n${folderNames.length > 0 ? folderNames.join(' / ') : '(暂无)'}`,
      },
    ];
    const resp = await llmService.chat({ messages, temperature: 0.3, maxTokens: 2048 });
    const suggestions = parseSuggestions(resp.content);
    logger.info(`[hot-topics] 生成选题建议 ${suggestions.length} 条`);
    return { suggestions, topicCount: topics.length };
  }

  /**
   * 选题一键生成口播脚本并落盘
   * @param topic 选题标题
   * @returns { script, path } 脚本内容与落盘路径
   */
  async generateScript(topic: string): Promise<{ script: string; path: string }> {
    const t = topic.trim();
    if (!t) throw new Error('hot-topics:generateScript 入参无效:topic 不能为空');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是短视频口播稿写手。根据选题写一篇文章 150-250 字的口播脚本:开头 3 秒强钩子,中间 2-3 个论点,结尾引导互动。仅输出脚本文本,不要任何解释或标题标记。',
      },
      { role: 'user', content: `选题:${t}` },
    ];
    const resp = await llmService.chat({ messages, temperature: 0.3, maxTokens: 1024 });
    const script = resp.content.trim();
    const path = this.persistScript(t, script);
    logger.info(`[hot-topics] 脚本已生成: ${path}`);
    return { script, path };
  }

  /**
   * 脚本落盘(userData/hot-topics/scripts/)
   * @param topic 选题标题(文件名成分)
   * @param script 脚本内容
   * @returns 落盘路径
   */
  private persistScript(topic: string, script: string): string {
    const safeName = topic.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'topic';
    const dir = join(app.getPath('userData'), 'hot-topics', 'scripts');
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${safeName}-${Date.now().toString(36)}.txt`);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, script, 'utf8');
    return fp;
  }
}

/** 热点选题编排器单例 */
export const hotTopicService = new HotTopicService();
