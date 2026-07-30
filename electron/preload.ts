/**
 * Electron preload 脚本
 * 职责:在隔离的上下文中向渲染层暴露受限的 IPC 调用接口
 */
import { contextBridge, ipcRenderer } from 'electron';

// IPC 调用的统一入参结构
export interface IpcRequest<T = unknown> {
  payload: T;
}

// IPC 返回的统一响应结构
export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// 渲染层监听器类型
type RendererListener = (...args: unknown[]) => void;

// 已包装的监听器映射:原始监听器 → 包装后的监听器(供 off 查找)
const listenerWrappers = new WeakMap<RendererListener, (event: unknown, ...args: unknown[]) => void>();

// 暴露给渲染层的 API 形状
export interface ExposedApi {
  // 发起一次 IPC 调用
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResponse<TResp>>;
  // 订阅主进程推送的事件(进度/日志等),返回取消订阅函数
  on: (channel: string, listener: RendererListener) => () => void;
  // 取消订阅(与 on 配合,需传入相同的监听器引用)
  off: (channel: string, listener: RendererListener) => void;
  // 单向发送(渲染层 → 主进程,不等回应)
  send: (channel: string, payload?: unknown) => void;
}

// 通过 contextBridge 安全暴露 API,避免渲染层直接访问 Node
contextBridge.exposeInMainWorld('api', {
  /**
   * 发起 IPC invoke 调用,自动包装错误为 { ok: false, error }
   */
  invoke: async <TReq, TResp>(channel: string, payload?: TReq): Promise<IpcResponse<TResp>> => {
    try {
      const result = await ipcRenderer.invoke(channel, payload);
      return result as IpcResponse<TResp>;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  /**
   * 订阅主进程事件,返回取消订阅函数
   * 内部包装监听器以剥离 event 参数,并记录映射供 off 使用
   */
  on: (channel: string, listener: RendererListener) => {
    const wrapped = (_event: unknown, ...args: unknown[]): void => listener(...args);
    listenerWrappers.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
    // 返回取消订阅函数(也可使用 off 显式取消)
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
      listenerWrappers.delete(listener);
    };
  },
  /**
   * 显式取消订阅(需传入与 on 相同的监听器引用)
   */
  off: (channel: string, listener: RendererListener) => {
    const wrapped = listenerWrappers.get(listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
      listenerWrappers.delete(listener);
    }
  },
  /**
   * 单向发送消息到主进程(不等回应)
   */
  send: (channel: string, payload?: unknown) => {
    ipcRenderer.send(channel, payload);
  },
});
