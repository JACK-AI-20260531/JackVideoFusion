/**
 * LLM Provider 共享 HTTP 工具
 * 职责:封装 Node.js 原生 fetch 的 POST JSON 请求,统一超时与错误处理
 *       供 OpenAI / Ollama Provider 复用,避免重复实现
 * 技术选型:Node 22 内置 fetch + AbortController,不引入额外 HTTP 依赖
 */

/** 默认请求超时(ms) */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 拼接 base URL 与 path,避免出现双斜杠
 * @param base API base URL,如 https://api.openai.com/v1
 * @param path 接口路径,如 /chat/completions
 * @returns 拼接后的完整 URL
 */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

/**
 * 发起 POST JSON 请求并返回解析后的响应体
 * - 使用 AbortController 实现 30s 超时,超时抛明确错误
 * - HTTP 非 2xx 抛带状态码与响应体的错误
 * - 调用方负责将返回的 unknown 断言为具体响应类型
 * @param url 完整请求 URL
 * @param body 请求体对象(将被 JSON.stringify)
 * @param headers 额外请求头(如 Authorization);Content-Type 默认已设置
 * @returns 解析后的响应 JSON
 */
export async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: finalHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 [${resp.status} ${resp.statusText}]: ${errText}`);
    }
    return await resp.json();
  } catch (err) {
    // AbortController 触发的超时单独提示,其余错误原样抛出
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LLM 请求超时(${DEFAULT_TIMEOUT_MS}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
