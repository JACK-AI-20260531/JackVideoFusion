/**
 * 文案生成服务编排:LLM 调用 + 容错解析 + 中文错误降级(PRD-v2.2 FR-1.3)
 * 设计要点:chat 能力依赖注入(默认 llmService.chat),纯逻辑在 copywriting.ts 可单测;
 *          未配置 LLM / 调用失败 / 解析失败均返回 { ok:false, error },不向 IPC 层抛错
 */
import type { ChatMessage, ChatResponse } from '../llm';
import { llmService } from '../llm';
import { logger } from '../../utils/logger';
import type { PublishPlatform } from '../auto-publish/types';
import { buildCopyPrompt, parseCopyResponse } from './copywriting';
import type { Copywriting } from './copywriting';

/** 文案生成结果:成功携带数据,失败携带中文错误 */
export type CopywritingResult =
  | { ok: true; data: Copywriting }
  | { ok: false; error: string };

/** 文案服务依赖(chat 可注入替换,便于测试与降级) */
export interface CopywritingDeps {
  /** 聊天补全能力(默认 llmService.chat) */
  chat?: (req: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
  }) => Promise<ChatResponse>;
}

/** 文案生成默认参数 */
const CHAT_TEMPERATURE = 0.3;
const CHAT_MAX_TOKENS = 600;

/**
 * 生成发布文案
 * @param title 用户输入的视频标题/主题/草稿
 * @param platform 目标平台
 * @param deps 依赖注入(chat 可替换)
 * @returns 成功返回文案;失败返回 { ok:false, error }(中文,可直接展示)
 */
export async function generateCopywriting(
  title: string,
  platform: PublishPlatform,
  deps: CopywritingDeps = {},
): Promise<CopywritingResult> {
  const chat = deps.chat ?? ((req) => llmService.chat(req));
  const messages = buildCopyPrompt(title, platform);
  try {
    const resp = await chat({ messages, temperature: CHAT_TEMPERATURE, maxTokens: CHAT_MAX_TOKENS });
    const parsed = parseCopyResponse(resp.content);
    if (!parsed) {
      const head = resp.content.slice(0, 100);
      logger.warn(`[copywriting] 文案解析失败: ${head}`);
      return { ok: false, error: `文案生成失败:模型输出无法解析(${head}…)` };
    }
    logger.info(`[copywriting] 文案生成成功: platform=${platform} titles=${parsed.titles.length}`);
    return { ok: true, data: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[copywriting] 文案生成失败: ${msg}`);
    if (msg.includes('未配置') || msg.includes('provider')) {
      return { ok: false, error: '请先在系统设置中配置 LLM 服务' };
    }
    return { ok: false, error: `文案生成失败: ${msg}` };
  }
}

export {
  PLATFORM_STYLE,
  COPYWRITING_SYSTEM,
  buildCopyPrompt,
  parseCopyResponse,
  extractJsonObject,
} from './copywriting';
export type { Copywriting, PlatformStyle } from './copywriting';
