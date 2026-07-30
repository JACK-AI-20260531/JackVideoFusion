/**
 * LLM 服务类型定义
 * 职责:定义 LLM 服务的配置、消息、请求/响应、关键词结果及抽象接口
 *       供 Provider 实现、LlmService 入口及 IPC 层共同使用
 *
 * 说明:LlmConfig 与 src/main/services/config-service/types.ts 中
 *       AppConfig.llm 结构对齐,provider 字段包含 'custom'
 *       (自定义 OpenAI 兼容端点),由 createProvider 路由到 OpenAIProvider。
 */

/**
 * LLM 服务商
 * - openai: OpenAI 官方及兼容接口
 * - qwen: 阿里通义千问(OpenAI 兼容)
 * - ollama: Ollama 本地模型
 * - custom: 自定义 OpenAI 兼容端点(与 AppConfig.llm.provider 对齐)
 */
export type LlmProvider = 'openai' | 'qwen' | 'ollama' | 'custom';

/**
 * LLM 配置(与 AppConfig.llm 结构对齐)
 */
export interface LlmConfig {
  /** 服务商 */
  provider: LlmProvider;
  /** API base URL,如 https://api.openai.com/v1 */
  endpoint: string;
  /** API 密钥(ollama 可为空) */
  apiKey: string;
  /** 模型名,如 gpt-4o-mini / qwen-plus / llama3 */
  model: string;
}

/**
 * 聊天消息
 */
export interface ChatMessage {
  /** 角色:system / user / assistant */
  role: 'system' | 'user' | 'assistant';
  /** 消息内容 */
  content: string;
}

/**
 * 聊天请求
 */
export interface ChatRequest {
  /** 消息列表(至少含一条 user 消息) */
  messages: ChatMessage[];
  /** 采样温度,默认 0.7 */
  temperature?: number;
  /** 最大生成 token 数,默认 2048 */
  maxTokens?: number;
}

/**
 * 聊天响应
 */
export interface ChatResponse {
  /** 模型生成的文本内容 */
  content: string;
  /** token 用量(部分 Provider 可能不返回) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 实际使用的模型名 */
  model: string;
}

/**
 * 关键词抽取结果
 */
export interface KeywordResult {
  /** 抽取出的关键词列表 */
  keywords: string[];
  /** LLM 原始输出文本(调试用) */
  raw: string;
}

/**
 * LLM Provider 底层接口
 * 各 Provider(OpenAI/Ollama)实现该接口,提供底层 chat 与 embeddings 能力
 * 上层 LlmService 在此基础上实现 extractKeywords / testConnection
 */
export interface ILlmProvider {
  /** 发起一次聊天补全 */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 文本向量化(后续 CLIP 对比用,可选能力) */
  embeddings(input: string): Promise<number[]>;
}

/**
 * LLM 服务抽象接口
 * LlmService 实现该接口,对外暴露聊天、关键词抽取、连通性测试能力
 */
export interface ILlmService {
  /** 发起一次聊天补全 */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 从文案中抽取画面匹配关键词 */
  extractKeywords(text: string, maxCount?: number): Promise<KeywordResult>;
  /** 测试当前配置的连通性 */
  testConnection(): Promise<boolean>;
}
