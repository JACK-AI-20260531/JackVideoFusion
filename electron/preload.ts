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

// 暴露给渲染层的 API 形状
export interface ExposedApi {
  // 发起一次 IPC 调用
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResponse<TResp>>;
  // 订阅主进程推送的事件(进度/日志等)
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}

// 通过 contextBridge 安全暴露 API,避免渲染层直接访问 Node
contextBridge.exposeInMainWorld('api', {
  invoke: async <TReq, TResp>(channel: string, payload?: TReq): Promise<IpcResponse<TResp>> => {
    try {
      const result = await ipcRenderer.invoke(channel, payload);
      return result as IpcResponse<TResp>;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const wrapped = (_event: unknown, ...args: unknown[]): void => listener(...args);
    ipcRenderer.on(channel, wrapped);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
