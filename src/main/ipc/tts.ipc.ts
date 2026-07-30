/**
 * TTS 服务 IPC 注册
 * 职责:将 TtsService 的方法暴露为 tts:* 系列 IPC 通道
 *       供渲染层通过 ipcRenderer.invoke('tts:xxx', payload) 调用
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 *
 * 进度事件:
 *   主进程会通过 BrowserWindow.webContents.send('tts:progress', payload) 推送进度,
 *   渲染层可使用 ipcRenderer.on('tts:progress', cb) 订阅。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { ttsService } from '../services/tts';
import type { TtsParams, TtsResult, VoiceInfo } from '../services/tts';

/** listVoices 的载荷:可选 locale 用于过滤 */
interface ListVoicesPayload {
  locale?: string;
}

/**
 * 注册 TTS 服务 IPC handlers
 * 通道列表:
 *   tts:listVoices      - 列出可用音色(可选 locale 过滤)
 *   tts:synthesize      - 单次合成(支持 5W 字符超长文本)
 *   tts:synthesizeBatch - 批量合成(多段文本一次性排队输出)
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 列出可用音色
   * payload: { locale?: string } 或直接传入 locale 字符串
   * 返回: VoiceInfo[]
   */
  safeHandle(ipc, 'tts:listVoices', async (_event, payload) => {
    // 兼容两种入参形式:{ locale } 或 直接字符串
    let locale: string | undefined;
    if (typeof payload === 'string') {
      locale = payload;
    } else if (payload && typeof payload === 'object') {
      locale = (payload as ListVoicesPayload).locale;
    }
    return ttsService.listVoices(locale);
  });

  /**
   * 单次合成(支持 5W 字符超长文本)
   * payload: TtsParams
   * 返回: TtsResult
   */
  safeHandle(ipc, 'tts:synthesize', async (_event, payload) => {
    const p = payload as TtsParams;
    if (!p || typeof p !== 'object') {
      throw new Error('tts:synthesize 参数无效:期望 TtsParams 对象');
    }
    if (!p.text || typeof p.text !== 'string') {
      throw new Error('tts:synthesize 参数无效:缺少 text 字段');
    }
    if (!p.outputPath || typeof p.outputPath !== 'string') {
      throw new Error('tts:synthesize 参数无效:缺少 outputPath 字段');
    }
    return ttsService.synthesize(p);
  });

  /**
   * 批量合成:多段文本一次性排队输出
   * payload: TtsParams[]
   * 返回: TtsResult[](顺序与入参一致)
   */
  safeHandle(ipc, 'tts:synthesizeBatch', async (_event, payload) => {
    if (!Array.isArray(payload)) {
      throw new Error('tts:synthesizeBatch 参数无效:期望 TtsParams[] 数组');
    }
    const items = payload as TtsParams[];
    return ttsService.synthesizeBatch(items);
  });
}

/** 导出类型供渲染层 preload 复用 */
export type { TtsParams, TtsResult, VoiceInfo };
