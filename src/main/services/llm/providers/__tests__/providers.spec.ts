import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../openai.ts';
import { OllamaProvider } from '../ollama.ts';

interface CapturedCall {
  url: string;
  body: any;
  headers?: Record<string, string>;
}

function makeFakePost(responses: Array<() => unknown>): {
  fake: (url: string, body: unknown, headers?: Record<string, string>) => Promise<unknown>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fake = async (url: string, body: unknown, headers?: Record<string, string>) => {
    const idx = calls.length;
    calls.push({ url, body, headers });
    const make = responses[Math.min(idx, responses.length - 1)];
    return make();
  };
  return { fake, calls };
}

describe('OpenAIProvider', () => {
  test('chat:构造 body/headers,解析响应并提取 usage', async () => {
    const { fake, calls } = makeFakePost([() => ({
      choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: 'gpt-4o-mini',
    })]);

    const p = new OpenAIProvider(
      { provider: 'openai', endpoint: 'https://api.openai.com/v1/', apiKey: 'sk-123', model: 'gpt-4o-mini' },
      { postJson: fake },
    );

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(res.content, '你好');
    assert.equal(res.model, 'gpt-4o-mini');
    assert.deepEqual(res.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].headers!['Authorization'], 'Bearer sk-123');
    assert.deepEqual(calls[0].body, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 2048,
    });
  });

  test('chat:自定义 temperature/maxTokens 生效', async () => {
    const { fake, calls } = makeFakePost([() => ({ choices: [{ message: { content: 'x' } }] })]);
    const p = new OpenAIProvider(
      { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'm' },
      { postJson: fake },
    );
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, maxTokens: 512 });
    assert.equal(calls[0].body.temperature, 0.2);
    assert.equal(calls[0].body.max_tokens, 512);
  });

  test('chat:无 usage 或无 message 时安全回退', async () => {
    const { fake } = makeFakePost([() => ({ choices: [{}] })]);
    const p = new OpenAIProvider(
      { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'm' },
      { postJson: fake },
    );
    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.content, '');
    assert.equal(res.usage, undefined);
    assert.equal(res.model, 'm');
  });

  test('embeddings:提取向量并规范数值;空数组回退', async () => {
    const { fake, calls } = makeFakePost([() => ({ data: [{ embedding: [0.5, '1', 2] }], model: 'm' })]);
    const p = new OpenAIProvider(
      { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' },
      { postJson: fake },
    );
    const vec = await p.embeddings('text');
    assert.deepEqual(vec, [0.5, 1, 2]);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
    assert.deepEqual(calls[0].body, { model: 'm', input: 'text' });

    const { fake: fake2 } = makeFakePost([() => ({ data: [] })]);
    const p2 = new OpenAIProvider(
      { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' },
      { postJson: fake2 },
    );
    assert.deepEqual(await p2.embeddings('x'), []);
  });
});

describe('OllamaProvider', () => {
  test('chat:构造 ollama body(stream:false)并解析 usage', async () => {
    const { fake, calls } = makeFakePost([() => ({
      model: 'llama3',
      message: { role: 'assistant', content: '回复' },
      done: true,
      prompt_eval_count: 8,
      eval_count: 4,
    })]);
    const p = new OllamaProvider(
      { provider: 'ollama', endpoint: 'http://localhost:11434/', apiKey: '', model: 'llama3' },
      { postJson: fake },
    );

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, maxTokens: 100 });

    assert.equal(res.content, '回复');
    assert.equal(res.model, 'llama3');
    assert.deepEqual(res.usage, { promptTokens: 8, completionTokens: 4, totalTokens: 12 });
    assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
    assert.deepEqual(calls[0].body, {
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      options: { temperature: 0.3, num_predict: 100 },
    });
    // Ollama 不使用 apiKey
    assert.equal(calls[0].headers, undefined);
  });

  test('chat:无 eval_count 时 usage 为 undefined', async () => {
    const { fake } = makeFakePost([() => ({ message: { content: 'ok' } })]);
    const p = new OllamaProvider(
      { provider: 'ollama', endpoint: 'http://localhost:11434', apiKey: '', model: 'llama3' },
      { postJson: fake },
    );
    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.content, 'ok');
    assert.equal(res.usage, undefined);
  });

  test('embeddings:使用 prompt 字段;空向量回退空数组', async () => {
    const { fake, calls } = makeFakePost([() => ({ embedding: [1.5, 2.5] })]);
    const p = new OllamaProvider(
      { provider: 'ollama', endpoint: 'http://localhost:11434', apiKey: '', model: 'llama3' },
      { postJson: fake },
    );
    assert.deepEqual(await p.embeddings('text'), [1.5, 2.5]);
    assert.equal(calls[0].url, 'http://localhost:11434/api/embeddings');
    assert.deepEqual(calls[0].body, { model: 'llama3', prompt: 'text' });

    const { fake: fake2 } = makeFakePost([() => ({})]);
    const p2 = new OllamaProvider(
      { provider: 'ollama', endpoint: 'http://localhost:11434', apiKey: '', model: 'llama3' },
      { postJson: fake2 },
    );
    assert.deepEqual(await p2.embeddings('x'), []);
  });
});
