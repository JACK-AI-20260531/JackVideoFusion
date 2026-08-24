/**
 * Ollama 本地模型 Provider
 * 职责:对接 Ollama HTTP API(无需 apiKey,默认 endpoint http://localhost:11434)
 *       使用 Node.js 原生 fetch,无额外 HTTP 依赖
 *
 * 接口参考:https://github.com/ollama/ollama/blob/main/docs/api.md
 */
import { joinUrl, postJson } from './http';
import type { ChatRequest, ChatResponse, ILlmProvider, LlmConfig } from '../types';

/** Ollama /api/chat 响应结构(仅声明使用的字段) */
interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  /** 生成的 token 数(不含 prompt) */
  eval_count?: number;
  /** prompt 的 token 数 */
  prompt_eval_count?: number;
}

/** Ollama /api/embeddings 响应结构 */
interface OllamaEmbeddingsResponse {
  embedding?: number[];
}

/**
 * Ollama 本地模型 Provider
 * 构造时接收 LlmConfig(apiKey 字段不被使用)
 */
export class OllamaProvider implements ILlmProvider {
  private readonly postJson: typeof postJson;

  /**
   * @param config LLM 配置(endpoint / model;apiKey 忽略)
   * @param deps 可选依赖注入(测试用);默认使用模块级 postJson
   */
  constructor(
    private readonly config: LlmConfig,
    deps?: { postJson?: typeof postJson },
  ) {
    this.postJson = deps?.postJson ?? postJson;
  }

  /**
   * 发起一次聊天补全
   * POST `${endpoint}/api/chat`,关闭流式输出(stream:false)
   * @param req 聊天请求(消息列表 + 可选采样参数)
   * @returns 聊天响应(含 content / usage / model)
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = joinUrl(this.config.endpoint, '/api/chat');
    const body = {
      model: this.config.model,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        num_predict: req.maxTokens ?? 2048,
      },
    };

    const data = (await this.postJson(url, body)) as OllamaChatResponse;
    const content = data?.message?.content ?? '';

    let usage: ChatResponse['usage'];
    if (typeof data?.eval_count === 'number' && typeof data?.prompt_eval_count === 'number') {
      usage = {
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
        totalTokens: data.prompt_eval_count + data.eval_count,
      };
    }

    return {
      content,
      model: data?.model ?? this.config.model,
      usage,
    };
  }

  /**
   * 生成文本向量
   * POST `${endpoint}/api/embeddings`
   * @param input 待向量化的文本
   * @returns 浮点向量;失败或为空返回空数组
   */
  async embeddings(input: string): Promise<number[]> {
    const url = joinUrl(this.config.endpoint, '/api/embeddings');
    const body = { model: this.config.model, prompt: input };

    const data = (await this.postJson(url, body)) as OllamaEmbeddingsResponse;
    const vec = data?.embedding;
    if (!Array.isArray(vec)) return [];
    return vec.map((n) => (typeof n === 'number' ? n : Number(n)));
  }
}
