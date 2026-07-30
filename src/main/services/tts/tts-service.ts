/**
 * TTS 主服务实现
 * 职责:
 *   1) 实现 TtsService 接口契约(listVoices / synthesize / synthesizeBatch)
 *   2) 5W 字符超长合成分片策略:
 *      - splitLongText 按 ≤500 字符切分(优先段落 > 句末 > 硬切)
 *      - 逐分片流式调用 EdgeTtsEngine.synthesizeChunk(自动重试 2 次)
 *      - Buffer.concat 合并各分片 mp3 → 单个 mp3 文件
 *      - SRT 按累计分片时长生成,保证字幕与音频对齐
 *   3) 通过 BrowserWindow.webContents.send 推送进度到渲染层
 */

import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import { logger } from '../../utils/logger';
import { EdgeTtsEngine } from './edge-tts-engine';
import { splitLongText } from './text-splitter';
import { generateSrtContent } from './srt-generator';
import type {
  VoiceInfo,
  VoiceGender,
  TtsParams,
  TtsResult,
  TtsService,
  ChunkSynthesisResult,
  TtsProgressPayload,
} from './types';
import type { Voice } from 'msedge-tts';

/** 默认音色(中文女声晓晓) */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 最大字符硬性上限(5W) */
const MAX_CHAR_LIMIT = 50000;

/**
 * 主服务实现类
 */
class TtsServiceImpl implements TtsService {
  /** 引擎实例(类内复用,自动重连) */
  private readonly engine: EdgeTtsEngine;

  constructor() {
    this.engine = new EdgeTtsEngine();
  }

  /**
   * 列出可用音色,可按 locale 过滤
   * @param locale 可选区域过滤,如"zh-CN"
   * @returns 裁剪后的 VoiceInfo 数组
   */
  async listVoices(locale?: string): Promise<VoiceInfo[]> {
    const rawVoices = await this.engine.fetchVoices();
    const filtered = locale
      ? rawVoices.filter((v) => v.Locale.toLowerCase().startsWith(locale.toLowerCase()))
      : rawVoices;

    return filtered.map((v) => mapVoice(v));
  }

  /**
   * 单次合成:支持 5W 字符超长文本
   * @param params 合成参数
   * @returns 合成结果
   */
  async synthesize(params: TtsParams): Promise<TtsResult> {
    return this.synthesizeInternal(params, undefined);
  }

  /**
   * 批量合成:多段文本一次性排队输出
   * @param items 多段合成参数(每段独立支持 5W 字符)
   * @returns 每段对应的合成结果(顺序与入参一致)
   */
  async synthesizeBatch(items: TtsParams[]): Promise<TtsResult[]> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('批量合成入参为空');
    }

    const results: TtsResult[] = [];
    const batchTotal = items.length;

    for (let i = 0; i < items.length; i++) {
      logger.info(`[TTS-Service] 批量合成 ${i + 1}/${batchTotal}:${items[i].outputPath}`);
      const result = await this.synthesizeInternal(items[i], { batchIndex: i, batchTotal });
      results.push(result);
    }

    logger.info(`[TTS-Service] 批量合成完成,共 ${results.length}/${batchTotal} 段成功`);
    return results;
  }

  /**
   * 内部合成实现(支持可选的批次上下文,用于进度推送)
   * @param params 合成参数
   * @param batchCtx 批次上下文(批量合成时传入)
   * @returns 合成结果
   */
  private async synthesizeInternal(params: TtsParams, batchCtx?: { batchIndex: number; batchTotal: number }): Promise<TtsResult> {
    // 1) 入参校验
    validateParams(params);

    const voice = params.voice ?? DEFAULT_VOICE;
    const prosody = {
      rate: params.rate,
      volume: params.volume,
      pitch: params.pitch,
    };

    /** 局部进度推送闭包:自动补齐批次字段 */
    const emitProgress = (payload: Omit<TtsProgressPayload, 'batchIndex' | 'batchTotal'>): void => {
      this.sendProgress({ ...payload, ...batchCtx });
    };

    // 2) 长文本分片(5W 字符 → 多个 ≤500 字符分片)
    emitProgress({ current: 0, total: 0, stage: 'splitting' });

    const chunks = splitLongText(params.text);
    if (chunks.length === 0) {
      throw new Error('待合成文本为空,请输入有效内容');
    }

    logger.info(`[TTS-Service] 文本已切分:${params.text.length} 字符 → ${chunks.length} 分片,音色=${voice}`);

    // 3) 逐分片流式合成(自动重试由引擎负责)
    const synthesisResults: ChunkSynthesisResult[] = [];
    emitProgress({ current: 0, total: chunks.length, stage: 'synthesizing' });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.debug(`[TTS-Service] 合成分片 ${i + 1}/${chunks.length}(${chunk.text.length} 字符)`);

      const out = await this.engine.synthesizeChunk(chunk.text, voice, prosody);
      synthesisResults.push({
        buffer: out.buffer,
        text: chunk.text,
        durationSec: out.durationSec,
        offset: chunk.offset,
      });

      // 推送进度(1-based)
      emitProgress({ current: i + 1, total: chunks.length, stage: 'synthesizing' });
    }

    // 4) 拼接所有分片 mp3 → 单个 mp3 文件
    emitProgress({ current: chunks.length, total: chunks.length, stage: 'merging' });

    const mergedBuffer = Buffer.concat(synthesisResults.map((r) => r.buffer));
    const totalDurationSec = synthesisResults.reduce((sum, r) => sum + r.durationSec, 0);

    await fs.writeFile(params.outputPath, mergedBuffer);
    logger.info(`[TTS-Service] mp3 已写入:${params.outputPath}(${mergedBuffer.length} 字节,${totalDurationSec.toFixed(2)}s)`);

    // 5) 可选:生成 SRT 字幕
    let srtPath: string | undefined;
    if (params.srtPath) {
      const srtContent = generateSrtContent(synthesisResults);
      await fs.writeFile(params.srtPath, srtContent, 'utf8');
      srtPath = params.srtPath;
      logger.info(`[TTS-Service] srt 已写入:${srtPath}(${synthesisResults.length} 条字幕)`);
    }

    // 6) 完成
    emitProgress({ current: chunks.length, total: chunks.length, stage: 'done' });

    return {
      audioPath: params.outputPath,
      srtPath,
      durationSec: totalDurationSec,
      charCount: params.text.length,
    };
  }

  /**
   * 向渲染层推送合成进度
   * 若当前无窗口则仅写日志,避免抛错
   * @param payload 进度载荷
   */
  private sendProgress(payload: TtsProgressPayload): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('tts:progress', payload);
    }
    logger.debug(`[TTS-Service] 进度推送:stage=${payload.stage} current=${payload.current}/${payload.total}`);
  }
}

/**
 * 将 msedge-tts 原始 Voice 转为对外的 VoiceInfo
 * @param v 原始 Voice
 * @returns 简化后的 VoiceInfo
 */
function mapVoice(v: Voice): VoiceInfo {
  // SDK 的 Gender 字段为字符串"Male"/"Female",做容错处理
  const genderRaw = (v.Gender || '').toLowerCase();
  const gender: VoiceGender = genderRaw === 'female' ? 'Female' : 'Male';

  return {
    name: v.Name,
    shortName: v.ShortName,
    gender,
    locale: v.Locale,
  };
}

/**
 * 校验合成参数,不合法时抛出明确错误
 * @param params 合成参数
 */
function validateParams(params: TtsParams): void {
  if (!params) {
    throw new Error('TTS 参数为空');
  }
  if (!params.text || params.text.trim().length === 0) {
    throw new Error('待合成文本为空');
  }
  if (!params.outputPath) {
    throw new Error('输出 mp3 路径未指定');
  }

  // 5W 字符硬性上限校验
  const charCount = Array.from(params.text).length;
  if (charCount > MAX_CHAR_LIMIT) {
    throw new Error(`文本长度 ${charCount} 超过硬性上限 ${MAX_CHAR_LIMIT}(5W 字符)`);
  }
}

/** TTS 服务单例 */
export const ttsService: TtsService = new TtsServiceImpl();
