import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postJson } from '../http.ts';

const realFetch = globalThis.fetch;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Partial<Response>>): void {
  (globalThis as any).fetch = async (url: any, init: any) => {
    const r = await impl(url, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: r.json ?? (async () => ({})),
      text: r.text ?? (async () => ''),
      ...r,
    } as Response;
  };
}

describe('postJson', () => {
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    mock.restoreAll();
  });

  test('成功:发送 JSON 并解析响应', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    stubFetch((url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ content: 'hi', model: 'm' }) };
    });

    const result = await postJson('https://api.example.com/chat', {
      model: 'gpt',
      messages: [],
    }, { Authorization: 'Bearer x' });

    assert.deepEqual(result, { content: 'hi', model: 'm' });
    assert.equal(captured!.url, 'https://api.example.com/chat');
    assert.equal(captured!.init.method, 'POST');
    assert.equal((captured!.init.headers as any)['Content-Type'], 'application/json');
    assert.equal((captured!.init.headers as any)['Authorization'], 'Bearer x');
    assert.equal(captured!.init.body, JSON.stringify({ model: 'gpt', messages: [] }));
  });

  test('HTTP 非 2xx:抛出带状态码与响应体的错误', async () => {
    stubFetch(() => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid key',
    }));

    await assert.rejects(
      postJson('https://api.example.com/chat', { model: 'gpt' }),
      (err: any) => err.message.includes('401') && err.message.includes('Unauthorized') && err.message.includes('invalid key'),
    );
  });

  test('响应体非 JSON:抛出解析错误(原样转发)', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));

    await assert.rejects(
      postJson('https://api.example.com/chat', { model: 'gpt' }),
      (err: any) => err instanceof SyntaxError,
    );
  });
});
