/**
 * 语音克隆 IPC 注册
 *
 * 职责:将 voiceCloneService 的能力暴露为 IPC 通道,供渲染层调用
 *
 * 通道列表:
 *   voice-clone:listVoices   - 列出音色库
 *   voice-clone:cloneSample  - 克隆样本(渲染层先通过 dialog:openFile 选文件,再传 samplePath)
 *   voice-clone:deleteVoice  - 删除音色
 *   voice-clone:synthesize   - 用克隆音色合成 TTS(入队 task-queue,类型 'voice-clone-synthesize')
 *   voice-clone:checkService - 检查 GPT-SoVITS 服务状态
 *   voice-clone:startService - 启动 GPT-SoVITS 服务
 *   voice-clone:stopService  - 停止 GPT-SoVITS 服务
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 */
import type { ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { safeHandle } from '../../../electron/ipc/index';
import { voiceCloneService, voiceLibrary } from '../services/voice-clone';
import { CancelToken, FFmpegError } from '../services/ffmpeg/types';
import { taskQueue } from '../services/task-queue';
import type { TaskItem } from '../services/task-queue/types';
import type { TaskType } from '../../shared/types';
import type {
  ClonedVoice,
  CloneSampleParams,
  CloneSynthParams,
  CloneSynthResult,
  GptSoVitsConfig,
  GptSoVitsStatus,
} from '../services/voice-clone';
import { logger } from '../utils/logger';

/**
 * 活跃合成任务的 CancelToken 映射:taskId → CancelToken
 * 用于 cancel 时找到对应令牌触发取消(本任务规格未要求 cancel 通道,但保留映射便于扩展)
 */
const activeTokens = new Map<string, CancelToken>();

/** voice-clone:synthesize 返回结构 */
interface SynthResp {
  /** 任务 ID */
  taskId: string;
  /** 合成结果 */
  result: CloneSynthResult;
}

/** voice-clone:checkService 请求载荷 */
interface CheckServicePayload {
  /** GPT-SoVITS 安装路径(可选,触发检测) */
  installPath?: string;
}

/** voice-clone:startService 请求载荷 */
interface StartServicePayload {
  /** 服务配置 */
  config: GptSoVitsConfig;
}

/**
 * 注册语音克隆相关 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 列出音色库
   * 返回: ClonedVoice[]
   */
  safeHandle(ipc, 'voice-clone:listVoices', async () => {
    return voiceCloneService.listVoices();
  });

  /**
   * 克隆样本(渲染层先调用 dialog:openFile 选文件,再把 path 传到这里)
   * payload: CloneSampleParams
   * 返回: ClonedVoice
   */
  safeHandle(ipc, 'voice-clone:cloneSample', async (_event, payload: unknown) => {
    const params = payload as CloneSampleParams;
    if (!params || typeof params !== 'object') {
      throw new Error('voice-clone:cloneSample 参数无效:期望 CloneSampleParams 对象');
    }
    if (typeof params.samplePath !== 'string' || params.samplePath.trim().length === 0) {
      throw new Error('voice-clone:cloneSample 入参无效:samplePath 必填');
    }
    if (typeof params.sampleName !== 'string' || params.sampleName.trim().length === 0) {
      throw new Error('voice-clone:cloneSample 入参无效:sampleName 必填');
    }
    if (typeof params.refText !== 'string') {
      throw new Error('voice-clone:cloneSample 入参无效:refText 必填(参考文本)');
    }
    return voiceCloneService.cloneSample(params);
  });

  /**
   * 删除音色
   * payload: { voiceId }
   * 返回: { deleted: voiceId }
   */
  safeHandle(ipc, 'voice-clone:deleteVoice', async (_event, payload: unknown) => {
    const { voiceId } = payload as { voiceId: string };
    if (!voiceId || typeof voiceId !== 'string') {
      throw new Error('voice-clone:deleteVoice 入参缺失 voiceId');
    }
    const ok = await voiceCloneService.deleteVoice(voiceId);
    if (!ok) {
      logger.warn(`[IPC] voice-clone:deleteVoice 音色不存在: ${voiceId}`);
    }
    return { deleted: voiceId };
  });

  /**
   * 读取指定音色的参考音频(用于前端试听)
   * payload: { voiceId }
   * 返回: { mime, data } ,data 为二进制 ArrayBuffer
   */
  safeHandle(ipc, 'voice-clone:readRefAudio', async (_event, payload: unknown) => {
    const { voiceId } = payload as { voiceId: string };
    if (!voiceId || typeof voiceId !== 'string') {
      throw new Error('voice-clone:readRefAudio 入参缺失 voiceId');
    }
    const voice = await voiceLibrary.getVoice(voiceId);
    if (!voice || !voice.refAudioPath) {
      throw new Error(`voice-clone:readRefAudio 音色不存在或缺少参考音频: ${voiceId}`);
    }
    const ext = extname(voice.refAudioPath).toLowerCase();
    const mime =
      ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.flac' ? 'audio/flac' : 'audio/wav';
    const buf = await readFile(voice.refAudioPath);
    return { mime, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });

  /**
   * 用克隆音色合成 TTS(入队 task-queue,类型 'voice-clone-synthesize')
   * payload: CloneSynthParams
   * 返回: { taskId, result }
   */
  safeHandle(ipc, 'voice-clone:synthesize', async (_event, payload: unknown) => {
    const params = payload as CloneSynthParams;
    if (!params || typeof params !== 'object') {
      throw new Error('voice-clone:synthesize 参数无效:期望 CloneSynthParams 对象');
    }
    if (typeof params.text !== 'string' || params.text.trim().length === 0) {
      throw new Error('voice-clone:synthesize 入参无效:text 必填且不能为空');
    }
    if (typeof params.voiceId !== 'string' || params.voiceId.trim().length === 0) {
      throw new Error('voice-clone:synthesize 入参无效:voiceId 必填');
    }
    if (typeof params.outputPath !== 'string' || params.outputPath.trim().length === 0) {
      throw new Error('voice-clone:synthesize 入参无效:outputPath 必填');
    }

    // 构造 TaskItem 入队
    const taskId = `vc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskType: TaskType = 'voice-clone-synthesize';
    const task: TaskItem = {
      id: taskId,
      type: taskType,
      title: '克隆音色 TTS 合成',
      status: 'pending',
      progress: 0,
      params: params as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    taskQueue.enqueue(task);

    // 创建 CancelToken
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    logger.info(`[IPC] voice-clone:synthesize 任务 ${taskId} 已入队`);

    try {
      const result: CloneSynthResult = await voiceCloneService.synthesize(
        params,
        taskId,
        token,
      );
      taskQueue.complete(taskId, result.audioPath);
      activeTokens.delete(taskId);
      logger.info(
        `[IPC] voice-clone:synthesize 任务 ${taskId} 完成: ${result.audioPath}`,
      );
      const resp: SynthResp = { taskId, result };
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 区分取消与其他失败:取消时 taskQueue.cancel 已被调用,此处仅清理 token
      const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
      if (!isCancelled) {
        taskQueue.fail(taskId, msg);
      }
      activeTokens.delete(taskId);
      logger.error(`[IPC] voice-clone:synthesize 任务 ${taskId} 失败: ${msg}`);
      throw err;
    }
  });

  /**
   * 检查 GPT-SoVITS 服务状态
   * payload: { installPath? }
   * 返回: GptSoVitsStatus
   */
  safeHandle(ipc, 'voice-clone:checkService', async (_event, payload: unknown) => {
    const p = (payload ?? {}) as CheckServicePayload;
    const installPath =
      typeof p.installPath === 'string' && p.installPath.length > 0
        ? p.installPath
        : undefined;
    const status: GptSoVitsStatus = await voiceCloneService.checkService(installPath);
    return status;
  });

  /**
   * 启动 GPT-SoVITS 服务
   * payload: { config: GptSoVitsConfig }
   * 返回: { started: boolean, status: GptSoVitsStatus }
   */
  safeHandle(ipc, 'voice-clone:startService', async (_event, payload: unknown) => {
    const p = payload as StartServicePayload;
    if (!p || !p.config || typeof p.config !== 'object') {
      throw new Error('voice-clone:startService 入参无效:期望 { config: GptSoVitsConfig }');
    }
    const config = p.config as GptSoVitsConfig;
    if (typeof config.installPath !== 'string' || config.installPath.trim().length === 0) {
      throw new Error('voice-clone:startService 入参无效:config.installPath 必填');
    }
    if (typeof config.port !== 'number' || config.port <= 0) {
      throw new Error('voice-clone:startService 入参无效:config.port 必须为正整数');
    }
    const started = await voiceCloneService.startService(config);
    return { started, status: await voiceCloneService.checkService() };
  });

  /**
   * 停止 GPT-SoVITS 服务
   * 返回: { stopped: boolean, status: GptSoVitsStatus }
   */
  safeHandle(ipc, 'voice-clone:stopService', async () => {
    const stopped = await voiceCloneService.stopService();
    return { stopped, status: await voiceCloneService.checkService() };
  });
}

/** 导出类型供渲染层 preload 复用 */
export type {
  ClonedVoice,
  CloneSampleParams,
  CloneSynthParams,
  CloneSynthResult,
  GptSoVitsConfig,
  GptSoVitsStatus,
};
