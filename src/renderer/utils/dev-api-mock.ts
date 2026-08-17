/**
 * Dev 环境 IPC Mock Polyfill
 * 职责:在浏览器 dev 环境下(npm run dev)注入 window.api 的 mock 实现,
 *       让渲染层 UI 可在纯浏览器中正常浏览和交互,不会因 IPC 不可用而崩溃。
 *
 * 触发条件:
 *   - 非 Electron 环境(window.api 未由 preload 注入)
 *   - 仅 dev 环境(VITE_DEVTOOLS_ENV 等条件不必,因为 Electron 真实环境 preload 必然注入)
 *
 * 行为:
 *   - invoke: 返回 { ok: false, error: 'IPC 不可用:当前为浏览器 dev 环境' }
 *   - on: 返回 no-op unsubscribe 函数
 *   - off: no-op
 *   - send: no-op
 *
 * 这样所有视图组件无需任何改动,按钮点击会得到结构化错误反馈,
 * UI 可正常渲染,便于在浏览器中做 UI/路由/交互测试。
 *
 * 真实 Electron 环境:preload.ts 通过 contextBridge.exposeInMainWorld('api', ...)
 *   注入真实 API,本 mock 检测到 window.api 已存在则直接跳过,不影响生产。
 */

// Mock API 形状(与 preload.ts 的 ExposedApi 保持一致)
interface MockApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<{ ok: boolean; data?: TResp; error?: string }>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
  send: (channel: string, payload?: unknown) => void;
}

/**
 * 检测当前是否为浏览器 dev 环境(非 Electron)
 * 通过判断 window.api 是否已被 preload 注入
 */
function isBrowserDevEnv(): boolean {
  // Electron 真实环境 preload 会注入 window.api
  if ((window as unknown as { api?: unknown }).api !== undefined) {
    return false;
  }
  // 进一步判断是否在浏览器中(无 process.versions.electron)
  const w = window as unknown as { process?: { versions?: { electron?: string } } };
  return !w.process?.versions?.electron;
}

/**
 * 创建 Mock API 实例
 */
function createMockApi(): MockApi {
  const ERR_MSG = 'IPC 不可用:当前为浏览器 dev 环境,请在 Electron 中运行以使用完整功能';

  return {
    // invoke 统一返回 ok:false,让视图层走错误处理分支
    invoke: async <TReq>(_channel: string, _payload?: TReq) => ({
      ok: false as const,
      error: ERR_MSG,
    }),
    // on 返回 no-op 取消订阅函数(避免视图层调用 .on().() 崩溃)
    on: (_channel: string, _listener: (...args: unknown[]) => void) => () => {},
    // off 无操作
    off: (_channel: string, _listener: (...args: unknown[]) => void) => {},
    // send 无操作
    send: (_channel: string, _payload?: unknown) => {},
  };
}

/**
 * 安装 mock polyfill(若需要)
 * 在 main.ts 顶部、createApp 之前调用
 */
export function setupDevApiMock(): void {
  if (isBrowserDevEnv()) {
    (window as unknown as { api: MockApi }).api = createMockApi();
    // 仅在 dev 环境输出一次提示
    console.warn('[dev-mock] 检测到浏览器 dev 环境,已注入 IPC mock。完整功能请在 Electron 中运行。');
  }
}
