/**
 * LLM 服务 IPC 注册
 * 职责:将 LlmService 的方法暴露为 llm:* 系列 IPC 通道
 *       供渲染层通过 ipcRenderer.invoke('llm:xxx', payload) 调用
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { llmService } from '../services/llm';
import type { ChatRequest } from '../services/llm';

/** llm:extractKeywords 请求载荷 */
interface ExtractKeywordsPayload {
  /** 待抽取的文案 */
  text: string;
  /** 最大关键词数量(可选,默认 10) */
  maxCount?: number;
}

/**
 * 注册 LLM 服务 IPC handlers
 * 通道列表:
 *   llm:chat           - 发起一次聊天补全
 *   llm:extractKeywords - 从文案中抽取画面匹配关键词
 *   llm:testConnection  - 测试当前 LLM 配置的连通性
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 发起一次聊天补全
   * payload: ChatRequest({ messages, temperature?, maxTokens? })
   * 返回: ChatResponse({ content, usage?, model })
   */
  safeHandle(ipc, 'llm:chat', async (_event, payload) => {
    const p = payload as ChatRequest;
    if (!p || typeof p !== 'object' || !Array.isArray(p.messages)) {
      throw new Error('llm:chat 参数无效:期望含 messages 数组的 ChatRequest 对象');
    }
    return llmService.chat(p);
  });

  /**
   * 从文案中抽取画面匹配关键词
   * payload: { text: string, maxCount?: number }
   * 返回: KeywordResult({ keywords: string[], raw: string })
   */
  safeHandle(ipc, 'llm:extractKeywords', async (_event, payload) => {
    const p = payload as ExtractKeywordsPayload;
    if (!p || typeof p.text !== 'string') {
      throw new Error('llm:extractKeywords 参数无效:缺少 text 字段');
    }
    return llmService.extractKeywords(p.text, p.maxCount);
  });

  /**
   * 测试当前 LLM 配置的连通性
   * 返回: boolean
   */
  safeHandle(ipc, 'llm:testConnection', async () => {
    return llmService.testConnection();
  });
}

/** 导出类型供渲染层 preload 复用 */
export type { ChatRequest, ChatResponse, ChatMessage, KeywordResult } from '../services/llm';
