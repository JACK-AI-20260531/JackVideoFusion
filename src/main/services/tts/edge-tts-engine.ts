/**
 * msedge-tts 引擎封装
 * 职责:
 *   1) 封装 MsEdgeTTS 单例,处理 WebSocket 生命周期
 *   2) 单分片合成:接收文本与韵律参数,返回 mp3 Buffer + 估算时长
 *   3) 失败重试 2 次,指数退避(500ms / 1000ms / 2000ms)
 *   4) 网络错误 / 引擎错误 / 字符错误 分类抛出
 */

import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions, Voice } from 'msedge-tts';
import { Readable } from 'stream';
import { logger } from '../../utils/logger';

/** 用户接口的韵律参数(百分比 -100~100,默认 0) */
export interface ProsodyParams {
  /** 语速百分比,正数加快、负数减慢 */
  rate?: number;
  /** 音量百分比 */
  volume?: number;
  /** 音调百分比 */
  pitch?: number;
}

/** 单分片合成产物 */
export interface EngineSynthesisOutput {
  /** mp3 二进制数据 */
  buffer: Buffer;
  /** 基于比特率估算的音频时长(秒) */
  durationSec: number;
}

/** 最大重试次数(总尝试 = 1 + MAX_RETRIES = 3) */
const MAX_RETRIES = 2;

/** 退避基数(毫秒),实际等待 = base * 2^attempt */
const BACKOFF_BASE_MS = 500;

/** 当前输出格式对应的比特率(kbps) */
const MP3_BITRATE_KBPS = 48;

/**
 * 将用户接口的韵律参数转换为 msedge-tts ProsodyOptions
 * 用户输入为百分比 -100~100,0 表示不变;
 * SDK 期望相对字符串:"+50%" / "-30%" / "+0Hz"
 * @param params 用户韵律参数
 * @returns SDK ProsodyOptions 实例
 */
function toProsodyOptions(params: ProsodyParams): ProsodyOptions {
  const opts = new ProsodyOptions();
  const rate = clampPercent(params.rate ?? 0);
  const volume = clampPercent(params.volume ?? 0);
  const pitch = clampPercent(params.pitch ?? 0);

  // rate: SDK 支持相对百分比字符串
  opts.rate = `${rate >= 0 ? '+' : ''}${rate}%`;
  // volume: 同样使用相对百分比
  opts.volume = `${volume >= 0 ? '+' : ''}${volume}%`;
  // pitch: 使用 Hz 单位,百分比近似映射到 ±50Hz
  opts.pitch = `${pitch >= 0 ? '+' : ''}${pitch * 0.5}Hz`;
  return opts;
}

/**
 * 将百分比限制在 [-100, 100] 区间
 * @param value 原始值
 * @returns 限幅后的值
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

/**
 * 等待指定毫秒数
 * @param ms 毫秒
 * @returns Promise
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 对错误进行分类,便于上层给出清晰报错
 * @param err 原始错误
 * @returns 分类后的 Error,带 .category 字段
 */
export function classifyTtsError(err: unknown): Error & { category: 'network' | 'character' | 'engine' } {
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(message) as Error & { category: 'network' | 'character' | 'engine' };

  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|WebSocket|connect|network|网络/i.test(message)) {
    wrapped.category = 'network';
  } else if (/SSML|invalid character|character|字符|too long/i.test(message)) {
    wrapped.category = 'character';
  } else {
    wrapped.category = 'engine';
  }
  return wrapped;
}

/**
 * 从 mp3 字节数估算音频时长
 * 基于 CBR 比特率:时长(秒) = 字节数 × 8 / (比特率 bps)
 * @param buffer mp3 字节缓冲
 * @returns 时长(秒)
 */
export function estimateMp3DurationSec(buffer: Buffer): number {
  if (!buffer || buffer.length === 0) return 0;
  const bytesPerSec = (MP3_BITRATE_KBPS * 1000) / 8; // 48kbps → 6000 B/s
  return buffer.length / bytesPerSec;
}

/**
 * 从 Readable 流收集所有 mp3 chunks 并合并为单个 Buffer
 * @param stream msedge-tts 返回的可读流
 * @param signal 可选的中断信号
 * @returns 合并后的 mp3 Buffer
 */
function collectStreamChunks(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.once('error', (err: Error) => reject(err));

    // SDK 在 turn.end 时 push(null) 触发 end 事件
    stream.once('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
    });

    // 兼容 close 事件(部分版本不触发 end)
    stream.once('close', () => {
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * Edge-TTS 引擎封装类
 * 提供:音色列表查询、单分片合成(含重试)
 */
export class EdgeTtsEngine {
  /** MsEdgeTTS 实例(惰性创建) */
  private ttsInstance: MsEdgeTTS | null = null;
  /** 当前已设置的音色 */
  private currentVoice: string | null = null;
  /** 当前已设置的输出格式 */
  private currentFormat: OUTPUT_FORMAT | null = null;

  /**
   * 惰性获取 MsEdgeTTS 实例,并在音色/格式变化时重新设置元数据
   * @param voice 目标音色短名
   * @param format 输出格式,默认 24kHz 48kbps mono mp3
   */
  private async ensureInstance(voice: string, format: OUTPUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3): Promise<MsEdgeTTS> {
    if (!this.ttsInstance) {
      this.ttsInstance = new MsEdgeTTS(undefined, false);
    }

    // 音色或格式变化时重新 setMetadata(会重建 WebSocket)
    if (this.currentVoice !== voice || this.currentFormat !== format) {
      await this.ttsInstance.setMetadata(voice, format);
      this.currentVoice = voice;
      this.currentFormat = format;
    }
    return this.ttsInstance;
  }

  /**
   * 拉取微软 Edge 可用音色列表
   * @returns 原始 Voice 数组
   */
  async fetchVoices(): Promise<Voice[]> {
    const tts = await this.ensureInstance('zh-CN-XiaoxiaoNeural');
    return tts.getVoices();
  }

  /**
   * 合成单个文本分片为 mp3 Buffer,失败时按指数退避重试最多 2 次
   * @param text 单分片文本(建议 ≤500 字符)
   * @param voice 音色短名
   * @param prosody 韵律参数
   * @returns 引擎合成产物(Buffer + 时长)
   */
  async synthesizeChunk(text: string, voice: string, prosody: ProsodyParams): Promise<EngineSynthesisOutput> {
    const opts = toProsodyOptions(prosody);
    let lastError: unknown = null;

    // 共 3 次尝试(1 次主调 + 2 次重试)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tts = await this.ensureInstance(voice);
        const stream = tts.toStream(text, opts);
        const buffer = await collectStreamChunks(stream);

        if (buffer.length === 0) {
          throw new Error('引擎未返回任何音频数据(可能由于网络中断或 SSML 拒绝)');
        }

        const durationSec = estimateMp3DurationSec(buffer);
        if (attempt > 0) {
          logger.info(`[TTS-Engine] 第 ${attempt + 1} 次尝试成功,分片 ${text.length} 字符,${durationSec.toFixed(2)}s`);
        }
        return { buffer, durationSec };
      } catch (err) {
        lastError = err;
        const classified = classifyTtsError(err);
        logger.warn(`[TTS-Engine] 第 ${attempt + 1} 次合成失败 [${classified.category}]: ${classified.message}`);

        // 字符错误不可重试,直接抛出
        if (classified.category === 'character') {
          throw classified;
        }

        // 还有重试机会则等待退避
        if (attempt < MAX_RETRIES) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          await sleep(backoffMs);
          // 强制重建连接(避免复用半开 WebSocket)
          this.currentVoice = null;
          this.ttsInstance = null;
        }
      }
    }

    throw classifyTtsError(lastError);
  }

  /**
   * 关闭引擎底层 WebSocket 连接(用于清理资源)
   */
  dispose(): void {
    if (this.ttsInstance) {
      try {
        this.ttsInstance.close();
      } catch {
        // 忽略关闭错误
      }
      this.ttsInstance = null;
      this.currentVoice = null;
      this.currentFormat = null;
    }
  }
}
