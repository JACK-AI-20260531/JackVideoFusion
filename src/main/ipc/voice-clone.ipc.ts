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
  /** 合成结果;执行中被用户暂停时为 null */
  result: CloneSynthResult | null;
}

/** voice-clone:pause/resume/cancel 请求载荷 */
interface TaskIdPayload {
  /** 目标任务 ID */
  taskId: string;
}

/** voice-clone:checkService 请求载荷 */
interface CheckServicePayload {
  /** GPT-SoVITS 安装路径(可选,触发检测) */
  installPath?: string;
  /** GPT-SoVITS 服务地址(可选,远程地址时跳过本机安装检测) */
  host?: string;
}

/** voice-clone:startService 请求载荷 */
interface StartServicePayload {
  /** 服务配置 */
  config: GptSoVitsConfig;
}

/**
 * 执行语音克隆合成并处理完成/失败/暂停三种结局
 * - 完成:taskQueue.complete + 返回 result
 * - 失败:taskQueue.fail + 抛出错误
 * - 暂停(用户主动):保留 paused 状态与 checkpoint,返回 null(不抛错)
 * @param taskId 任务 ID
 * @param params 合成参数
 * @param token 取消令牌
 * @param source 调用来源(start/resume),用于日志
 * @returns 合成结果;执行中被用户暂停时返回 null
 */
async function executeSynthesize(
  taskId: string,
  params: CloneSynthParams,
  token: CancelToken,
  source: 'start' | 'resume',
): Promise<CloneSynthResult | null> {
  try {
    const result = await voiceCloneService.synthesize(params, taskId, token);
    taskQueue.complete(taskId, result.audioPath);
    activeTokens.delete(taskId);
    logger.info(
      `[IPC] voice-clone:${source} 任务 ${taskId} 完成: ${result.audioPath}`,
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCancelled = err instanceof FFmpegError && err.code === 'CANCELLED';
    const task = taskQueue.get(taskId);
    const isPaused = isCancelled && task && task.status === 'paused';

    if (!isCancelled) {
      taskQueue.fail(taskId, msg);
    }
    activeTokens.delete(taskId);

    if (isPaused) {
      // 用户暂停:保留 paused 状态与 checkpoint,不抛错
      logger.info(
        `[IPC] voice-clone:${source} 任务 ${taskId} 已暂停(用户主动,checkpoint 保留)`,
      );
      return null;
    }

    logger.error(`[IPC] voice-clone:${source} 任务 ${taskId} 失败: ${msg}`);
    throw err;
  }
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

    const result = await executeSynthesize(taskId, params, token, 'start');
    const resp: SynthResp = { taskId, result };
    return resp;
  });

  /**
   * 取消语音克隆合成任务(清除 checkpoint,不续渲染)
   * payload: { taskId }
   * 返回: { cancelled: taskId }
   */
  safeHandle(ipc, 'voice-clone:cancel', (_event, payload: unknown) => {
    const { taskId } = payload as TaskIdPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('voice-clone:cancel 入参缺失 taskId');
    }
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户取消语音克隆任务');
      activeTokens.delete(taskId);
    }
    taskQueue.cancel(taskId);
    logger.info(`[IPC] voice-clone:cancel 任务 ${taskId} 已取消`);
    return { cancelled: taskId };
  });

  /**
   * 暂停语音克隆合成任务
   * 先 taskQueue.pause(running→paused)再 token.cancel 中断分片循环。
   * service 在下次 assertNotCancelled 处抛 CANCELLED,executeSynthesize 检测
   * task.status==='paused' 后保留 checkpoint(已落盘分片),供 resume 续传。
   * payload: { taskId }
   * 返回: { paused: taskId }
   */
  safeHandle(ipc, 'voice-clone:pause', (_event, payload: unknown) => {
    const { taskId } = payload as TaskIdPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('voice-clone:pause 入参缺失 taskId');
    }
    // 先切换状态(running→paused),这样 executeSynthesize 的 catch 能识别为"暂停"
    taskQueue.pause(taskId);
    // 再 cancel token,触发 service 在下个分片前抛出 CANCELLED
    const token = activeTokens.get(taskId);
    if (token) {
      token.cancel('用户暂停语音克隆任务');
    }
    logger.info(`[IPC] voice-clone:pause 任务 ${taskId} 已暂停(token.cancel 已触发)`);
    return { paused: taskId };
  });

  /**
   * 恢复语音克隆合成任务(断点续渲染)
   * 从 taskQueue 取回原 params,新建 CancelToken,再次调 executeSynthesize。
   * service 内部 loadCheckpoint 跳过已合成分片,从上次断点续传。
   * payload: { taskId }
   * 返回: { taskId, result } — result 为 null 表示再次被暂停
   */
  safeHandle(ipc, 'voice-clone:resume', async (_event, payload: unknown) => {
    const { taskId } = payload as TaskIdPayload;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('voice-clone:resume 入参缺失 taskId');
    }

    const task = taskQueue.get(taskId);
    if (!task) {
      throw new Error(`voice-clone:resume 任务不存在: ${taskId}`);
    }
    if (task.status !== 'paused') {
      throw new Error(`voice-clone:resume 任务非暂停状态(当前: ${task.status})`);
    }

    // 取回原参数
    const params = task.params as unknown as CloneSynthParams;

    // 新建 token 替换旧的(旧 token 已 cancelled 不可复用)
    const token = new CancelToken(taskId);
    activeTokens.set(taskId, token);

    // 恢复状态(paused→running)
    taskQueue.resume(taskId);
    logger.info(`[IPC] voice-clone:resume 任务 ${taskId} 恢复执行(从 checkpoint 续渲染)`);

    const result = await executeSynthesize(taskId, params, token, 'resume');
    return { taskId, result };
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
    const host =
      typeof p.host === 'string' && p.host.trim().length > 0
        ? p.host.trim()
        : undefined;
    const status: GptSoVitsStatus = await voiceCloneService.checkService(installPath, host);
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
    const remote = typeof config.host === 'string' && config.host.trim().length > 0;
    if (!remote && (typeof config.installPath !== 'string' || config.installPath.trim().length === 0)) {
      throw new Error('voice-clone:startService 入参无效:config.installPath 必填(本地模式)');
    }
    if (typeof config.port !== 'number' || config.port <= 0) {
      throw new Error('voice-clone:startService 入参无效:config.port 必须为正整数');
    }
    const started = await voiceCloneService.startService(config);
    return { started, status: await voiceCloneService.checkService(config.installPath, config.host) };
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
