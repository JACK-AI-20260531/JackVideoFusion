/**
 * LLM 服务纯逻辑单测
 * 职责:验证 parseKeywords 关键词解析、createProvider 工厂分发、joinUrl URL 拼接
 * 说明:这些均为纯函数(LlmService 的 chat/extractKeywords 依赖真实 HTTP,不在此测)
 * 运行:npm run test 或 node --test --import tsx src/main/services/llm/__tests__/index.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeywords, createProvider, OpenAIProvider, OllamaProvider } from '../index.ts';
import { joinUrl } from '../providers/http.ts';
import type { LlmConfig } from '../types.ts';

function cfg(provider: LlmConfig['provider']): LlmConfig {
  return {
    provider,
    model: 'test-model',
    endpoint: 'http://localhost:11434',
    apiKey: '',
    temperature: 0.7,
    maxTokens: 512,
  } as LlmConfig;
}

describe('parseKeywords', () => {
  it('从 LLM 输出中提取 JSON 数组', () => {
    const raw = '以下是关键词：["猫","狗","天空"]';
    assert.deepEqual(parseKeywords(raw, 10), ['猫', '狗', '天空']);
  });

  it('JSON 数组内过滤空串与空白', () => {
    const raw = '["a", "", "  ", "b"]';
    assert.deepEqual(parseKeywords(raw, 10), ['a', 'b']);
  });

  it('非字符串项转为字符串', () => {
    const raw = '[123, true, null, "x"]';
    assert.deepEqual(parseKeywords(raw, 10), ['123', 'true', 'x']);
  });

  it('maxCount 截断返回数量', () => {
    const raw = '["a","b","c","d"]';
    assert.deepEqual(parseKeywords(raw, 2), ['a', 'b']);
  });

  it('JSON 解析失败时降级为分隔符切分', () => {
    const raw = '不是数组 {abc}';
    assert.deepEqual(parseKeywords(raw, 10), ['不是数组 {abc}']);
  });

  it('无 JSON 时按换行/逗号/顿号/分号切分', () => {
    const raw = '猫\n狗，天空、白云；大海';
    assert.deepEqual(parseKeywords(raw, 10), ['猫', '狗', '天空', '白云', '大海']);
  });

  it('去除序号前缀(英文句点/括号)', () => {
    const raw = '1. 猫\n2. 狗\n3) 鸟';
    assert.deepEqual(parseKeywords(raw, 10), ['猫', '狗', '鸟']);
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(parseKeywords('', 10), []);
    assert.deepEqual(parseKeywords('   ', 10), []);
  });
});

describe('createProvider', () => {
  it('ollama 返回 OllamaProvider', () => {
    assert.ok(createProvider(cfg('ollama')) instanceof OllamaProvider);
  });

  it('openai/qwen/custom 返回 OpenAIProvider', () => {
    assert.ok(createProvider(cfg('openai')) instanceof OpenAIProvider);
    assert.ok(createProvider(cfg('qwen')) instanceof OpenAIProvider);
    assert.ok(createProvider(cfg('custom')) instanceof OpenAIProvider);
  });

  it('未知 provider 抛明确错误', () => {
    assert.throws(() => createProvider(cfg('unknown' as never)), /不支持的 LLM provider/);
  });
});

describe('joinUrl', () => {
  it('拼接 base 与 path,避免双斜杠', () => {
    assert.equal(joinUrl('https://api.openai.com/v1', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(joinUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(joinUrl('https://api.openai.com/v1', 'chat/completions'), 'https://api.openai.com/v1/chat/completions');
  });
});
