/**
 * ASR 语音识别引擎封装(@huggingface/transformers Whisper ONNX)
 *
 * 职责:封装 Whisper 本地推理,隐藏模型加载、音频预处理细节,提供与 OCR 引擎同构的接口。
 *
 * 特性:
 *   - 基于 @huggingface/transformers 的 Whisper ONNX,本地推理,不依赖云端
 *   - 模型通过 env.cacheDir 缓存到 userData/models/asr,首次下载后离线复用
 *   - 音频预处理:用 ffmpeg 把视频/音频转为 16k 单声道原始 float32 PCM,再读为 Float32Array
 *     (Node 环境无 AudioContext,不能使用 read_audio)
 *   - 提供 mock 工厂供测试注入
 *
 * 设计约定:
 *   - WhisperAsrEngine 实现 AsrEngine 接口,便于测试注入 mock 识别器
 *   - transformers 动态 import,避免在非 Electron/测试环境顶层加载副作用
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { ffmpegService } from '../ffmpeg';
import type { AsrLang, AsrModelSize, AsrSegment } from './types';

/** ASR 引擎接口(便于测试注入替代实现) */
export interface AsrEngine {
  /** 确保模型就绪(懒加载),识别前必须调用 */
  ensureReady(): Promise<void>;
  /** 识别音频/视频文件,返回带时间戳的文本片段 */
  transcribe(audioPath: string, lang?: AsrLang): Promise<AsrSegment[]>;
  /** 释放引擎资源 */
  terminate(): Promise<void>;
}

/** 可注入的转写函数类型(测试用),输入音频路径与语言,输出片段 */
export type TranscribeFn = (audioPath: string, lang?: AsrLang) => Promise<AsrSegment[]>;

/** transformers 库的最小类型(仅声明用到的能力) */
interface TransformersLike {
  pipeline: (
    task: string,
    model?: string,
    opts?: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<(audio: Float32Array, gen: Record<string, unknown>) => Promise<any>>;
  env: {
    allowLocalModels?: boolean;
    cacheDir?: string;
    remoteHost?: string;
    useBrowserCache?: boolean;
  };
}

/** 采样率(Whisper 标准输入) */
const SAMPLE_RATE = 16000;

/** 模型规格 → 远端模型 id(多语种,支持中文) */
const MODEL_BY_SIZE: Record<AsrModelSize, string> = {
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
};

/** 临时 PCM 文件名前缀 */
const TMP_PREFIX = 'jvf_asr_';

/**
 * 基于 @huggingface/transformers 的真实 Whisper 引擎
 */
export class WhisperAsrEngine implements AsrEngine {
  private module: TransformersLike | null = null;
  private asr: ((audio: Float32Array, gen: Record<string, unknown>) => Promise<{
    text?: string;
    chunks?: Array<{ timestamp?: [number, number]; text?: string }>;
  }>) | null = null;
  private readonly modelSize: AsrModelSize;
  private readonly cacheDir: string;

  /**
   * @param modelSize Whisper 模型规格,默认 base
   * @param cacheDir 模型缓存目录(如 userData/models/asr),由 lang-store 提供
   */
  constructor(modelSize: AsrModelSize = 'base', cacheDir?: string) {
    this.modelSize = modelSize;
    this.cacheDir = cacheDir ?? '';
  }

  /**
   * 懒加载 transformers 模块与模型
   */
  async ensureReady(): Promise<void> {
    if (this.asr) return;
    if (!this.module) {
      // 动态导入,避免顶层副作用
      // Node16 CJS 编译下动态 import 得到 ESM 默认对象
      const mod = (await import('@huggingface/transformers')) as unknown as TransformersLike;
      this.module = mod;
      // 配置:模型缓存到 userData,离线复用;走镜像下载
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = false;
      if (this.cacheDir) mod.env.cacheDir = this.cacheDir;
      // 国内镜像(与项目 npmmirror 生态一致)
      mod.env.remoteHost = 'https://hf-mirror.com';
    }
    const modelId = MODEL_BY_SIZE[this.modelSize];
    logger.info(`[ASR] 加载 Whisper 模型 ${modelId}(${this.modelSize})...`);
    this.asr = await this.module.pipeline('automatic-speech-recognition', modelId, {
      dtype: 'fp32',
      device: 'cpu',
    });
    logger.info(`[ASR] Whisper 模型就绪(${this.modelSize})`);
  }

  /**
   * 把任意音/视频转为其可识别的原始 f32 PCM,再读为 Float32Array
   * (Node 环境无 AudioContext,read_audio 不可用,故用 ffmpeg + 自读 PCM)
   * @param audioPath 音/视频文件路径
   * @returns 16k 单声道 Float32Array 采样
   */
  private async loadAudio(audioPath: string): Promise<Float32Array> {
    const tmpPcm = join(tmpdir(), `${TMP_PREFIX}${randomUUID()}.f32`);
    try {
      // 转成 16k mono 原始 f32 PCM
      await ffmpegService.extractAudio(audioPath, tmpPcm, {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        format: 'f32le',
      });
      const buf = await readFile(tmpPcm);
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    } finally {
      // 清理临时 PCM 文件
      try {
        const { rm } = await import('fs/promises');
        await rm(tmpPcm, { force: true });
      } catch {
        /* 忽略清理错误 */
      }
    }
  }

  /**
   * 转写音频文件,返回带时间戳的文本片段
   * @param audioPath 音频/视频文件路径
   * @param lang 目标语言(默认 auto)
   * @returns 时间戳片段数组(按 startSec 升序)
   */
  async transcribe(audioPath: string, lang?: AsrLang): Promise<AsrSegment[]> {
    await this.ensureReady();
    if (!this.asr) throw new Error('ASR 引擎未就绪');

    const audio = await this.loadAudio(audioPath);
    const gen: Record<string, unknown> = {
      // 多语种模型必须显式指定语言;auto 时不传让模型自动检测
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    if (lang && lang !== 'auto') {
      gen.language = lang;
    }

    const out = await this.asr(audio, gen);
    const chunks = out?.chunks ?? [];
    const segments: AsrSegment[] = [];
    for (const c of chunks) {
      const text = (c?.text ?? '').trim();
      if (!text) continue;
      const ts = c?.timestamp;
      if (ts && Array.isArray(ts) && typeof ts[0] === 'number') {
        segments.push({
          startSec: ts[0],
          endSec: typeof ts[1] === 'number' ? ts[1] : ts[0],
          text,
        });
      } else {
        // 无时间戳时按占位宽度 1s
        segments.push({ startSec: 0, endSec: 1, text });
      }
    }
    return segments;
  }

  /**
   * 释放模型与模块资源
   */
  async terminate(): Promise<void> {
    this.asr = null;
    this.module = null;
  }
}

/**
 * 创建一个以注入转写函数驱动的引擎(测试/Mock 用)
 * @param fn 转写函数(输入音频路径与语言,输出片段)
 * @returns AsrEngine 实例
 */
export function createMockAsrEngine(fn: TranscribeFn): AsrEngine {
  let ready = false;
  return {
    async ensureReady() {
      ready = true;
    },
    async transcribe(audioPath: string, lang?: AsrLang) {
      if (!ready) {
        throw new Error('ASR 引擎未就绪');
      }
      return fn(audioPath, lang);
    },
    async terminate() {
      ready = false;
    },
  };
}
