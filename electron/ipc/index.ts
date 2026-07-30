/**
 * IPC 自动注册中心
 * 设计目的:各服务模块在自己的目录里 export 注册函数,
 *          本文件统一调用,避免多个 agent 修改同一入口造成冲突。
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { logger } from '../../src/main/utils/logger';

// 各服务模块的 IPC 注册函数(集成阶段统一 import)
import { register as registerConfig } from '../../src/main/ipc/config.ipc';
import { register as registerFfmpeg } from '../../src/main/ipc/ffmpeg.ipc';
import { register as registerMaterial } from '../../src/main/ipc/material.ipc';
import { register as registerTask } from '../../src/main/ipc/task.ipc';
import { register as registerTts } from '../../src/main/ipc/tts.ipc';
import { register as registerMaterialProcess } from '../../src/main/ipc/material-process.ipc';
import { register as registerDialog } from '../../src/main/ipc/dialog.ipc';
import { register as registerCommon } from '../../src/main/ipc/common.ipc';
import { register as registerVideoMix } from '../../src/main/ipc/video-mix.ipc';

// 注册函数签名:接收 ipcMain,自行注册自己的 handlers
export type IpcRegistrar = (ipc: typeof ipcMain) => void;

// 已注册的 channel 集合,用于去重和诊断
const registeredChannels = new Set<string>();

/**
 * 包装 ipcMain.handle,自动记录 channel 并统一错误处理
 */
export function safeHandle(
  ipc: typeof ipcMain,
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown> | unknown,
): void {
  if (registeredChannels.has(channel)) {
    logger.warn(`[IPC] channel "${channel}" 已注册,跳过重复注册`);
    return;
  }
  registeredChannels.add(channel);

  ipc.handle(channel, async (event, payload) => {
    try {
      const data = await handler(event, payload);
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[IPC] channel "${channel}" 调用失败: ${message}`);
      return { ok: false, error: message };
    }
  });
}

/**
 * 注册所有 IPC 服务模块
 * 新增服务时:在此数组追加 register 函数即可
 */
export function registerAllIpc(): void {
  const registrars: IpcRegistrar[] = [
    registerDialog,            // 对话框(文件/目录选择)
    registerConfig,            // 配置服务(002)
    registerFfmpeg,            // FFmpeg 服务(003)
    registerMaterial,          // 素材仓库(004)
    registerTask,              // 任务队列(005)
    registerTts,               // TTS 服务(006)
    registerMaterialProcess,   // 素材处理(007)
    registerCommon,            // 通用能力(009)
    registerVideoMix,          // 视频混剪(008)
  ];

  for (const registrar of registrars) {
    try {
      registrar(ipcMain);
    } catch (err) {
      logger.error(`[IPC] 注册失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info(`[IPC] 已注册 ${registeredChannels.size} 个 channel`);
}
