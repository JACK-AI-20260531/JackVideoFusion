/**
 * OpenAI 兼容接口 Provider
 * 职责:对接 OpenAI 官方及兼容接口(通义千问、自定义 OpenAI 兼容端点等)
 *       使用 Node.js 原生 fetch,无额外 HTTP 依赖
 *
 * 适用 provider 值:openai / qwen / custom
 * 端点示例:https://api.openai.com/v1 、
 *           https://dashscope.aliyuncs.com/compatible-mode/v1
 */
import { joinUrl, postJson } from './http';
import type { ChatRequest, ChatResponse, ILlmProvider, LlmConfig } from '../types';

/** OpenAI chat/completions 响应结构(仅声明使用的字段) */
interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

/** OpenAI embeddings 响应结构 */
interface OpenAiEmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
}

/**
 * OpenAI 兼容接口 Provider
 * 构造时接收 LlmConfig,提供 chat 与 embeddings 能力
 */
export class OpenAIProvider implements ILlmProvider {
  /**
   * @param config LLM 配置(endpoint / apiKey / model)
   */
  constructor(private readonly config: LlmConfig) {}

  /**
   * 发起一次聊天补全
   * POST `${endpoint}/chat/completions`
   * @param req 聊天请求(消息列表 + 可选采样参数)
   * @returns 聊天响应(含 content / usage / model)
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = joinUrl(this.config.endpoint, '/chat/completions');
    const body = {
      model: this.config.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 2048,
    };
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const data = (await postJson(url, body, headers)) as OpenAiChatResponse;
    const choice = data?.choices?.[0];
    const content = choice?.message?.content ?? '';

    let usage: ChatResponse['usage'];
    if (data?.usage) {
      usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }

    return {
      content,
      model: data?.model ?? this.config.model,
      usage,
    };
  }

  /**
   * 生成文本向量(后续 CLIP 对比用)
   * POST `${endpoint}/embeddings`
   * @param input 待向量化的文本
   * @returns 浮点向量;失败或为空返回空数组
   */
  async embeddings(input: string): Promise<number[]> {
    const url = joinUrl(this.config.endpoint, '/embeddings');
    const body = { model: this.config.model, input };
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const data = (await postJson(url, body, headers)) as OpenAiEmbeddingsResponse;
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return [];
    return vec.map((n) => (typeof n === 'number' ? n : Number(n)));
  }
}
