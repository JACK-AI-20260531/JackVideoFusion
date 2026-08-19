/**
 * 语音克隆主服务
 *
 * 职责:串联音色库(voiceLibrary)、HTTP 客户端(gptSoVitsClient)、
 *      服务管理(serviceManager),提供对外 API:
 *   - cloneSample():克隆样本(保存到音色库)
 *   - synthesize():用克隆音色合成 TTS(支持长文本分片 + SRT 生成)
 *   - listVoices()/deleteVoice():音色库管理
 *   - checkService()/startService()/stopService():GPT-SoVITS 服务生命周期
 *
 * 合成流程:
 *   1. 从音色库取出 ClonedVoice(获取 ref_audio_path 与 ref_text)
 *   2. 长文本 splitLongText 切分为 ≤500 字符的分片
 *   3. 逐分片调用 gptSoVitsClient.synthesize → wav Buffer
 *   4. concatWavBuffers 合并为单个 wav Buffer
 *   5. 写入 outputPath
 *   6. 可选:基于分片时长生成 SRT
 *
 * 复用约定:
 *   - 文本分片:tts/text-splitter.splitLongText
 *   - SRT 生成:tts/srt-generator.buildSrtEntries / generateSrtContent
 *   - 取消令牌:ffmpeg/types.CancelToken
 */

import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger';
import { voiceLibrary } from './voice-library';
import { gptSoVitsClient } from './gpt-sovits-client';
import { serviceManager } from './service-manager';
import { splitLongText } from '../tts/text-splitter';
import { generateSrtContent } from '../tts/srt-generator';
import { taskQueue } from '../task-queue';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type {
  ClonedVoice,
  CloneSampleParams,
  CloneSynthParams,
  CloneSynthResult,
  GptSoVitsConfig,
  GptSoVitsStatus,
} from './types';
import type { ChunkSynthesisResult } from '../tts/types';

/** 单分片字符上限(GPT-SoVITS 单次合成推荐 ≤500 字符) */
const CHUNK_MAX_CHARS = 500;

/** 合成进度推送 channel */
const PROGRESS_CHANNEL = 'voice-clone:progress';

/** 合成进度载荷 */
export interface VoiceCloneProgressPayload {
  /** 当前已完成分片序号(1-based) */
  current: number;
  /** 总分片数 */
  total: number;
  /** 当前合成阶段 */
  stage: 'splitting' | 'synthesizing' | 'merging' | 'done';
  /** 关联的任务 ID */
  taskId: string;
}

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('语音克隆任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 把克隆音色语言映射到 Edge-TTS 默认音色短名(降级时使用)
 * 映射规则:中英日韩各选一个女声 Neural 音色作为降级默认
 * @param language 克隆音色语言
 * @returns Edge-TTS 音色短名
 */
function mapCloneLanguageToEdgeVoice(
  language: 'zh' | 'en' | 'jp' | 'kr' | 'auto',
): string {
  const map: Record<typeof language, string> = {
    zh: 'zh-CN-XiaoxiaoNeural',
    en: 'en-US-AriaNeural',
    jp: 'ja-JP-NanamiNeural',
    kr: 'ko-KR-SunHiNeural',
    auto: 'zh-CN-XiaoxiaoNeural',
  };
  return map[language] ?? map.auto;
}

/**
 * 合并多个 wav Buffer 为单个 wav
 * 假设所有 wav 都是标准 PCM 16-bit,header 长度 44 字节
 * 实现策略:复用首个 wav 的 header,更新 RIFF/data size 字段,拼接所有 data 段
 * @param buffers 多个 wav Buffer
 * @returns 合并后的 wav Buffer
 */
function concatWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  // 取第一个 wav 的 header 模板(44 字节)
  const headerTemplate = buffers[0].slice(0, 44);

  // 收集所有 data 段(跳过 44 字节 header)
  const dataChunks: Buffer[] = [];
  let totalDataSize = 0;
  for (const buf of buffers) {
    if (buf.length > 44) {
      const data = buf.slice(44);
      dataChunks.push(data);
      totalDataSize += data.length;
    }
  }

  // 复制 header 并更新 size 字段
  const newHeader = Buffer.from(headerTemplate);
  // RIFF chunk size = 36 + data size(标准 PCM wav)
  newHeader.writeUInt32LE(36 + totalDataSize, 4);
  // data chunk size(位于偏移 40)
  newHeader.writeUInt32LE(totalDataSize, 40);

  return Buffer.concat([newHeader, ...dataChunks]);
}

/**
 * 语音克隆服务主类
 */
export class VoiceCloneService {
  /**
   * 克隆样本:将用户选择的样本保存到音色库
   * @param params 克隆样本参数
   * @returns 创建成功的音色记录
   */
  async cloneSample(params: CloneSampleParams): Promise<ClonedVoice> {
    logger.info(
      `[voice-clone/service] 克隆样本: ${params.sampleName}(${params.samplePath})`,
    );
    return voiceLibrary.saveVoice(params);
  }

  /**
   * 列出所有克隆音色
   * @returns 音色记录数组
   */
  async listVoices(): Promise<ClonedVoice[]> {
    return voiceLibrary.listVoices();
  }

  /**
   * 删除指定音色
   * @param id 音色 ID
   * @returns 是否删除成功
   */
  async deleteVoice(id: string): Promise<boolean> {
    return voiceLibrary.deleteVoice(id);
  }

  /**
   * 检查 GPT-SoVITS 服务状态
   * @param installPath 可选安装路径,用于触发检测
   * @returns 服务状态
   */
  async checkService(installPath?: string): Promise<GptSoVitsStatus> {
    if (installPath) {
      await serviceManager.checkInstalled(installPath);
    }
    return serviceManager.getStatus();
  }

  /**
   * 启动 GPT-SoVITS 服务
   * @param config 服务配置
   * @returns 是否启动成功
   */
  async startService(config: GptSoVitsConfig): Promise<boolean> {
    return serviceManager.start(config);
  }

  /**
   * 停止 GPT-SoVITS 服务
   * @returns 是否停止成功
   */
  async stopService(): Promise<boolean> {
    return serviceManager.stop();
  }

  /**
   * 用克隆音色合成 TTS
   * 流程:取音色 → 切分长文本 → 逐分片调用 GPT-SoVITS → 合并 wav → 写文件 → 生成 SRT
   *
   * 降级机制(016 AC5):
   *   - GPT-SoVITS 服务未就绪(not-installed/stopped/starting/error)→ 自动降级到 Edge-TTS
   *   - GPT-SoVITS 合成过程抛错 → 自动降级到 Edge-TTS(已合成的部分分片丢弃)
   *   - 降级时根据 voice.language 映射到对应的 Edge-TTS 默认音色
   *   - 结果中 fallback=true,fallbackReason 与 fallbackVoice 用于诊断
   *
   * @param params 合成参数
   * @param taskId 任务 ID(用于进度推送与取消)
   * @param token 取消令牌
   * @returns 合成结果(可能带 fallback 标记)
   */
  async synthesize(
    params: CloneSynthParams,
    taskId: string,
    token: CancelToken,
  ): Promise<CloneSynthResult> {
    assertNotCancelled(token, taskId);

    // 1. 入参校验
    this.validateParams(params);

    // 2. 取音色记录
    const voice = await voiceLibrary.getVoice(params.voiceId);
    if (!voice) {
      throw new Error(`音色不存在: ${params.voiceId}`);
    }

    logger.info(
      `[voice-clone/service] 任务 ${taskId} 启动合成: 音色=${voice.name},` +
        `文本 ${params.text.length} 字符,输出=${params.outputPath}`,
    );

    // 3. 校验 GPT-SoVITS 服务是否就绪;未就绪直接降级到 Edge-TTS
    const status = serviceManager.getStatus();
    if (status !== 'running') {
      logger.warn(
        `[voice-clone/service] 任务 ${taskId} GPT-SoVITS 服务未就绪(状态=${status}),降级到 Edge-TTS`,
      );
      return this.synthesizeViaEdgeTts(
        params,
        taskId,
        token,
        voice,
        `GPT-SoVITS 服务未就绪(状态=${status})`,
      );
    }

    // 4. 走 GPT-SoVITS 合成;失败时降级到 Edge-TTS
    try {
      return await this.synthesizeViaGptSoVits(params, taskId, token, voice);
    } catch (err) {
      // 用户主动取消不降级,直接抛出
      if (err instanceof FFmpegError && err.code === 'CANCELLED') {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[voice-clone/service] 任务 ${taskId} GPT-SoVITS 合成失败,降级到 Edge-TTS: ${reason}`,
      );
      return this.synthesizeViaEdgeTts(params, taskId, token, voice, reason);
    }
  }

  /**
   * 通过 GPT-SoVITS 合成(主路径)
   * 流程:长文本分片 → 逐分片调用 GPT-SoVITS → 合并 wav → 写文件 → 生成 SRT
   *
   * @param params 合成参数
   * @param taskId 任务 ID
   * @param token 取消令牌
   * @param voice 已加载的音色记录
   * @returns 合成结果(无 fallback 标记)
   */
  private async synthesizeViaGptSoVits(
    params: CloneSynthParams,
    taskId: string,
    token: CancelToken,
    voice: ClonedVoice,
  ): Promise<CloneSynthResult> {
    // 1. 长文本分片
    this.sendProgress(taskId, { current: 0, total: 0, stage: 'splitting', taskId });
    const chunks = splitLongText(params.text, CHUNK_MAX_CHARS);
    if (chunks.length === 0) {
      throw new Error('待合成文本为空,请输入有效内容');
    }

    logger.info(
      `[voice-clone/service] 任务 ${taskId} 文本已切分:${chunks.length} 分片`,
    );
    taskQueue.updateProgress(taskId, 5);

    // 2. 逐分片合成(支持断点续渲染)
    this.sendProgress(taskId, {
      current: 0,
      total: chunks.length,
      stage: 'synthesizing',
      taskId,
    });

    // 尝试从 checkpoint 恢复已合成分片(断点续渲染)
    // partDir 存放每个分片独立的 wav 文件,暂停后可从中读回已完成部分
    const partDir = join(`${params.outputPath}.parts`);
    await fs.mkdir(partDir, { recursive: true });

    interface PartMeta {
      text: string;
      durationSec: number;
      offset: number;
    }

    let startIndex = 0;
    let recoveredParts: PartMeta[] = [];

    const cp = taskQueue.loadCheckpoint(taskId);
    if (cp && cp.step === 'vc-synthesize') {
      const ctx = cp.context as
        | { startIndex?: number; parts?: PartMeta[] }
        | undefined;
      startIndex = Math.min(ctx?.startIndex ?? 0, chunks.length);
      recoveredParts = ctx?.parts ?? [];
      logger.info(
        `[voice-clone/service] 任务 ${taskId} 命中 checkpoint,从分片 ${startIndex + 1}/${chunks.length} 续渲染`,
      );
    }

    // 读回已落盘的分片字节
    const recoveredBodies: Buffer[] = [];
    for (let i = 0; i < startIndex; i++) {
      try {
        recoveredBodies.push(await fs.readFile(join(partDir, `${i}.wav`)));
      } catch {
        recoveredBodies.push(Buffer.alloc(0));
      }
    }

    // 先填充已恢复的分片(供 SRT 生成与合并使用)
    const synthesisResults: ChunkSynthesisResult[] = [];
    for (let i = 0; i < startIndex; i++) {
      const meta = recoveredParts[i];
      synthesisResults.push({
        buffer: recoveredBodies[i],
        text: meta?.text ?? '',
        durationSec: meta?.durationSec ?? 0,
        offset: meta?.offset ?? 0,
      });
    }

    for (let i = startIndex; i < chunks.length; i++) {
      assertNotCancelled(token, taskId);

      const chunk = chunks[i];
      logger.debug(
        `[voice-clone/service] 任务 ${taskId} 合成分片 ${i + 1}/${chunks.length}`,
      );

      const out = await gptSoVitsClient.synthesize({
        text: chunk.text,
        ref_audio_path: voice.refAudioPath,
        ref_text: voice.refText,
        text_language: voice.language,
        ref_text_language: voice.language,
      });

      const piece = {
        buffer: out.buffer,
        text: chunk.text,
        durationSec: out.durationSec,
        offset: chunk.offset,
      };
      synthesisResults.push(piece);

      // 将已合成分片落盘,便于 resume 续传
      await fs.writeFile(join(partDir, `${i}.wav`), out.buffer);

      // 更新 checkpoint:记录已合成数量与分片元数据(供 SRT 恢复)
      const parts: PartMeta[] = synthesisResults
        .filter((r) => r.buffer.length > 0)
        .map((r) => ({
          text: r.text,
          durationSec: r.durationSec,
          offset: r.offset,
        }));
      const percent = Math.round(((i + 1) / chunks.length) * 80) + 5; // 5~85
      taskQueue.saveCheckpoint(taskId, 'vc-synthesize', percent, {
        startIndex: i + 1,
        partDir,
        parts,
      });
      this.sendProgress(taskId, {
        current: i + 1,
        total: chunks.length,
        stage: 'synthesizing',
        taskId,
      });
    }

    // 3. 合并 wav 分片
    assertNotCancelled(token, taskId);
    this.sendProgress(taskId, {
      current: chunks.length,
      total: chunks.length,
      stage: 'merging',
      taskId,
    });

    const mergedBuffer = concatWavBuffers(
      synthesisResults.map((r) => r.buffer),
    );
    const totalDurationSec = synthesisResults.reduce(
      (sum, r) => sum + r.durationSec,
      0,
    );

    // 4. 写入输出文件
    await fs.writeFile(params.outputPath, mergedBuffer);
    logger.info(
      `[voice-clone/service] 任务 ${taskId} 音频已写入: ${params.outputPath}` +
        `(${mergedBuffer.length} 字节, ${totalDurationSec.toFixed(2)}s)`,
    );
    taskQueue.updateProgress(taskId, 90);

    // 5. 可选:生成 SRT 字幕
    let srtPath: string | undefined;
    if (params.srtPath) {
      const srtContent = generateSrtContent(synthesisResults);
      await fs.writeFile(params.srtPath, srtContent, 'utf8');
      srtPath = params.srtPath;
      logger.info(
        `[voice-clone/service] 任务 ${taskId} SRT 已写入: ${srtPath}(${synthesisResults.length} 条)`,
      );
    }

    // 5.5 清理临时分片目录(完成任务后不残留 .parts)
    try {
      await fs.rm(partDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响主流程
    }

    // 6. 完成
    taskQueue.updateProgress(taskId, 100);
    this.sendProgress(taskId, {
      current: chunks.length,
      total: chunks.length,
      stage: 'done',
      taskId,
    });

    return {
      audioPath: params.outputPath,
      srtPath,
      durationSec: totalDurationSec,
      charCount: params.text.length,
    };
  }

  /**
   * 通过 Edge-TTS 降级合成(016 AC5)
   * 复用 tts 服务的长文本分片与 SRT 生成能力,使用基于 voice.language 映射的默认音色
   *
   * 注意:Edge-TTS 输出 mp3 格式,即使 outputPath 扩展名为 .wav 也会写入 mp3 字节流
   *      下游使用 ffmpeg 处理时通常可自动识别容器,无需特殊处理
   *
   * @param params 合成参数
   * @param taskId 任务 ID
   * @param token 取消令牌
   * @param voice 已加载的音色记录(用于映射 Edge-TTS 音色)
   * @param reason 降级原因(写入日志与结果)
   * @returns 带 fallback 标记的合成结果
   */
  private async synthesizeViaEdgeTts(
    params: CloneSynthParams,
    taskId: string,
    token: CancelToken,
    voice: ClonedVoice,
    reason: string,
  ): Promise<CloneSynthResult> {
    assertNotCancelled(token, taskId);

    // 延迟导入避免 voice-clone ↔ tts 循环依赖(nodenext 下相对导入需显式扩展名)
    const { ttsService } = await import('../tts/index.js');
    const fallbackVoice = mapCloneLanguageToEdgeVoice(voice.language);

    logger.info(
      `[voice-clone/service] 任务 ${taskId} 降级 Edge-TTS: 音色=${fallbackVoice}, 文本 ${params.text.length} 字符`,
    );

    // 推送降级阶段进度
    this.sendProgress(taskId, {
      current: 0,
      total: 0,
      stage: 'splitting',
      taskId,
    });
    taskQueue.updateProgress(taskId, 5);

    // 调用 Edge-TTS 合成(内部已处理分片、SRT 生成、进度推送)
    const result = await ttsService.synthesize({
      text: params.text,
      voice: fallbackVoice,
      rate: params.rate,
      volume: params.volume,
      outputPath: params.outputPath,
      srtPath: params.srtPath,
    });

    // 透传取消校验:Edge-TTS 内部不支持外部 token,合成结束后再校验一次
    assertNotCancelled(token, taskId);

    taskQueue.updateProgress(taskId, 100);
    this.sendProgress(taskId, {
      current: 1,
      total: 1,
      stage: 'done',
      taskId,
    });

    logger.info(
      `[voice-clone/service] 任务 ${taskId} Edge-TTS 降级合成完成: ${result.audioPath} (${result.durationSec.toFixed(2)}s)`,
    );

    return {
      audioPath: result.audioPath,
      srtPath: result.srtPath,
      durationSec: result.durationSec,
      charCount: result.charCount,
      fallback: true,
      fallbackReason: reason,
      fallbackVoice,
    };
  }

  /**
   * 校验合成参数,不合法时抛出明确错误
   * @param params 合成参数
   */
  private validateParams(params: CloneSynthParams): void {
    if (!params) {
      throw new Error('语音克隆参数为空');
    }
    if (!params.text || params.text.trim().length === 0) {
      throw new Error('待合成文本为空');
    }
    if (!params.voiceId || params.voiceId.trim().length === 0) {
      throw new Error('voiceId 不能为空');
    }
    if (!params.outputPath || params.outputPath.trim().length === 0) {
      throw new Error('outputPath 不能为空');
    }
  }

  /**
   * 向渲染层推送合成进度
   * 若当前无窗口则仅写日志,避免抛错
   * @param taskId 任务 ID
   * @param payload 进度载荷
   */
  private sendProgress(taskId: string, payload: VoiceCloneProgressPayload): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(PROGRESS_CHANNEL, payload);
    }
    logger.debug(
      `[voice-clone/service] 进度:stage=${payload.stage} ` +
        `${payload.current}/${payload.total} taskId=${taskId}`,
    );
  }
}

/** 语音克隆服务单例(全局复用) */
export const voiceCloneService = new VoiceCloneService();
