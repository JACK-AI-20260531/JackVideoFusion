/**
 * LLM 服务统一入口
 * 职责:根据全局配置(AppConfig.llm)创建对应 Provider 并委托调用,
 *       在 Provider 之上实现关键词抽取与连通性测试等业务能力
 *
 * 设计要点:
 *   - Provider(openai/ollama)只负责底层 HTTP 调用,实现 ILlmProvider
 *   - LlmService 实现 ILlmService,组合 Provider,补充 prompts 驱动的高层方法
 *   - 配置懒加载:首次调用 chat 等方法时自动从 ConfigService 读取配置
 */
import { logger } from '../../utils/logger';
import { getConfigService } from '../config-service';
import { OpenAIProvider } from './providers/openai';
import { OllamaProvider } from './providers/ollama';
import { KEYWORD_EXTRACTION_SYSTEM, buildKeywordPrompt } from './prompts';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ILlmProvider,
  ILlmService,
  KeywordResult,
  LlmConfig,
} from './types';

/**
 * 根据配置创建对应 Provider
 * - openai / qwen / custom → OpenAIProvider(均走 OpenAI 兼容接口)
 * - ollama → OllamaProvider(本地 API 格式)
 * @param config LLM 配置
 * @returns Provider 实例
 */
function createProvider(config: LlmConfig): ILlmProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
    case 'qwen':
    case 'custom':
      return new OpenAIProvider(config);
    default: {
      // 穷尽性检查:新增 provider 未处理时此处编译报错
      const exhaustive: never = config.provider;
      throw new Error(`不支持的 LLM provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * 从 LLM 原始输出中解析关键词列表
 * 解析策略:
 *   1. 优先从文本中提取 JSON 数组
 *   2. 降级为按换行/逗号/顿号/分号分隔,并去除序号前缀
 * @param raw LLM 原始输出
 * @param maxCount 最大关键词数量
 * @returns 关键词数组
 */
function parseKeywords(raw: string, maxCount: number): string[] {
  // 1. 尝试从原文中提取 JSON 数组
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        const arr = parsed
          .map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (arr.length > 0) return arr.slice(0, maxCount);
      }
    } catch {
      // JSON 解析失败,降级到分隔符切分
    }
  }

  // 2. 按换行/逗号/顿号/分号分隔,去除序号前缀(如 "1. xxx" / "1、xxx")
  const tokens = raw
    .split(/[\r\n]+|[,，、;；]/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^\d+[.、)]\s*/, '').trim())
    .filter((s) => s.length > 0);
  return tokens.slice(0, maxCount);
}

/**
 * LLM 服务
 * 通过组合具体 Provider 实现 ILlmService,
 * 配置在首次调用时自动从 ConfigService 加载
 */
export class LlmService implements ILlmService {
  /** 当前 LLM 配置(配置加载后非空) */
  private config: LlmConfig | null = null;
  /** 底层 Provider 实例(配置加载后非空) */
  private provider: ILlmProvider | null = null;

  /**
   * 从 ConfigService 读取 llm 配置并创建 Provider
   * 幂等:可重复调用以刷新配置(配置变更后重新加载)
   */
  async configure(): Promise<void> {
    const configService = getConfigService();
    const appConfig = await configService.getConfig();
    const llm = appConfig.llm;
    this.config = llm;
    this.provider = createProvider(llm);
    logger.info(
      `[LLM] 已配置 provider=${llm.provider} model=${llm.model || '(未设置)'} endpoint=${llm.endpoint || '(未设置)'}`,
    );
  }

  /**
   * 发起一次聊天补全
   * 首次调用时自动加载配置
   * @param req 聊天请求
   * @returns 聊天响应
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.provider === null) await this.configure();
    const provider = this.provider;
    if (provider === null) {
      throw new Error('LLM 服务未配置:无法获取 provider');
    }
    return provider.chat(req);
  }

  /**
   * 从文案中抽取画面匹配关键词
   * 用关键词抽取系统提示词构造消息,调用 chat,再解析 JSON / 分隔符格式关键词
   * @param text 待抽取的文案
   * @param maxCount 最大关键词数量(默认 10)
   * @returns 关键词结果(含 keywords 与原始输出 raw)
   */
  async extractKeywords(text: string, maxCount = 10): Promise<KeywordResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: KEYWORD_EXTRACTION_SYSTEM },
      { role: 'user', content: buildKeywordPrompt(text, maxCount) },
    ];
    const resp = await this.chat({
      messages,
      temperature: 0.3,
      maxTokens: 512,
    });
    const keywords = parseKeywords(resp.content, maxCount);
    return { keywords, raw: resp.content };
  }

  /**
   * 测试当前配置的 LLM 连通性
   * 发送一个极简 chat("ping"),成功且返回非空内容视为连通
   * @returns 连通返回 true,否则 false(异常吞掉并记录日志)
   */
  async testConnection(): Promise<boolean> {
    try {
      if (this.provider === null) await this.configure();
      const provider = this.provider;
      if (provider === null) {
        logger.warn('[LLM] 连接测试失败:provider 未初始化');
        return false;
      }
      const resp = await provider.chat({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 16,
      });
      return resp.content.length > 0;
    } catch (err) {
      logger.error(`[LLM] 连接测试失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

/** LLM 服务单例 */
export const llmService = new LlmService();

/* ==================== 对外导出 ==================== */

export { OpenAIProvider } from './providers/openai';
export { OllamaProvider } from './providers/ollama';
export {
  KEYWORD_EXTRACTION_SYSTEM,
  SCENE_MATCH_SYSTEM,
  buildKeywordPrompt,
  buildSceneMatchPrompt,
} from './prompts';
export type {
  LlmProvider,
  LlmConfig,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  KeywordResult,
  ILlmProvider,
  ILlmService,
} from './types';
