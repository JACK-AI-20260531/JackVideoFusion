/**
 * GPT-SoVITS HTTP 客户端
 *
 * 职责:封装对 GPT-SoVITS api_v2 server 的 HTTP 调用,包括:
 *   - checkHealth():健康检查 GET /,确认服务可用
 *   - synthesize():合成语音 POST /tts,返回 wav 二进制 Buffer
 *   - setModel():设置 GPT 与 SoVITS 模型路径 POST /set_model(可选)
 *
 * 实现说明:
 *   - 仅使用 Node 内置 http 模块,避免引入额外依赖
 *   - 默认目标 http://127.0.0.1:9880,通过 setBaseUrl 动态切换端口
 *   - /tts 返回 audio/wav 字节流,直接收集为 Buffer
 *   - 超时控制:默认 30 秒,合成时可显式传入更长超时
 */

import http from 'http';
import { logger } from '../../utils/logger';

/** 默认主机(本地回环) */
const DEFAULT_HOST = '127.0.0.1';

/** 默认端口(GPT-SoVITS api_v2 默认) */
const DEFAULT_PORT = 9880;

/** 默认请求超时(毫秒) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 合成请求超时(毫秒,长文本可能需要更久) */
const SYNTH_TIMEOUT_MS = 120_000;

/** HTTP body 最大字节数(防止异常响应撑爆内存,50MB) */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * 合成入参(对应 GPT-SoVITS api_v2 的 /tts 字段)
 */
export interface GptSoVitsSynthParams {
  /** 待合成文本 */
  text: string;
  /** 参考音频文件路径(本地绝对路径,server 端可访问) */
  ref_audio_path: string;
  /** 参考文本(与参考音频对应) */
  ref_text: string;
  /** 待合成文本语言:zh / en / jp / kr / auto */
  text_language: string;
  /** 参考文本语言:zh / en / jp / kr / auto */
  ref_text_language: string;
  /** 是否分片返回(默认 false,长文本由客户端切分后多次调用) */
  return_fragment?: boolean;
  /** 语速,部分版本支持,可选 */
  speed?: number;
  /** 音量,部分版本支持,可选 */
  volume?: number;
}

/** setModel 入参 */
export interface GptSoVitsModelParams {
  /** GPT 模型路径 */
  gpt_model_path?: string;
  /** SoVITS 模型路径 */
  sovits_model_path?: string;
}

/** 合成结果 */
export interface GptSoVitsSynthResult {
  /** wav 二进制数据 */
  buffer: Buffer;
  /** 基于字节数估算的时长(秒,wav 16kHz 16bit mono) */
  durationSec: number;
}

/**
 * GPT-SoVITS HTTP 客户端
 * 通过 http.request 与本地 GPT-SoVITS server 通信
 */
export class GptSoVitsClient {
  /** 目标主机 */
  private host: string = DEFAULT_HOST;
  /** 目标端口 */
  private port: number = DEFAULT_PORT;

  /**
   * 设置目标地址(由 ServiceManager 在 start 后调用)
   * @param host 主机名,默认 127.0.0.1
   * @param port 端口,默认 9880
   */
  setBaseUrl(host: string = DEFAULT_HOST, port: number = DEFAULT_PORT): void {
    this.host = host;
    this.port = port;
  }

  /**
   * 健康检查:GET /
   * GPT-SoVITS api_v2 在服务就绪时返回 200 + "Success" 文本
   * @param timeoutMs 超时毫秒,默认 3 秒(健康检查应快速响应)
   * @returns 是否健康
   */
  checkHealth(timeoutMs: number = 3_000): Promise<boolean> {
    return this.requestText('GET', '/', undefined, timeoutMs)
      .then((text) => {
        // api_v2 健康检查返回 "Success" 文本,宽松匹配避免版本差异
        const ok = text.includes('Success') || text.includes('ok') || text.length > 0;
        return ok;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`[voice-clone/client] 健康检查失败: ${msg}`);
        return false;
      });
  }

  /**
   * 合成语音:POST /tts
   * 返回 audio/wav 字节流,内部收集为 Buffer
   * @param params 合成参数
   * @param timeoutMs 超时毫秒,默认 120 秒
   * @returns 合成结果(Buffer + 估算时长)
   */
  async synthesize(
    params: GptSoVitsSynthParams,
    timeoutMs: number = SYNTH_TIMEOUT_MS,
  ): Promise<GptSoVitsSynthResult> {
    const body = JSON.stringify(params);
    const buffer = await this.requestBuffer('POST', '/tts', body, timeoutMs);
    if (buffer.length === 0) {
      throw new Error('GPT-SoVITS 未返回任何音频数据');
    }
    return {
      buffer,
      durationSec: estimateWavDurationSec(buffer),
    };
  }

  /**
   * 设置模型:POST /set_model
   * 用于运行时切换 GPT/SoVITS 模型,可选能力
   * @param params 模型路径参数
   * @returns 是否设置成功
   */
  async setModel(params: GptSoVitsModelParams): Promise<boolean> {
    if (!params.gpt_model_path && !params.sovits_model_path) {
      throw new Error('setModel 至少需要传入 gpt_model_path 或 sovits_model_path 之一');
    }
    const body = JSON.stringify(params);
    const text = await this.requestText('POST', '/set_model', body, DEFAULT_TIMEOUT_MS);
    return text.includes('Success') || text.length > 0;
  }

  /**
   * 发送请求并获取文本响应(用于健康检查 / set_model 等小响应)
   * @param method HTTP 方法
   * @param path 请求路径
   * @param body 请求体(可选)
   * @param timeoutMs 超时毫秒
   * @returns 响应文本
   */
  private requestText(
    method: string,
    path: string,
    body?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    return this.requestBuffer(method, path, body, timeoutMs).then((buf) =>
      buf.toString('utf8'),
    );
  }

  /**
   * 发送请求并获取 Buffer 响应(用于 /tts 字节流)
   * 统一封装请求构造、错误处理、超时与 body 收集
   * @param method HTTP 方法
   * @param path 请求路径
   * @param body 请求体(可选,JSON 字符串)
   * @param timeoutMs 超时毫秒
   * @returns 响应 Buffer
   */
  private requestBuffer(
    method: string,
    path: string,
    body?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {
        'User-Agent': 'JackVideoFusion/1.0',
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          // 非 2xx 视为错误,收集少量响应体供诊断
          if (res.statusCode === undefined || res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (c: Buffer | string) => (errBody += c.toString()));
            res.once('end', () => {
              reject(
                new Error(
                  `GPT-SoVITS ${method} ${path} 返回 ${res.statusCode}: ${errBody.slice(-512)}`,
                ),
              );
            });
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on('data', (chunk: Buffer | Uint8Array) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > MAX_BODY_BYTES) {
              reject(new Error(`GPT-SoVITS 响应体超过 ${MAX_BODY_BYTES} 字节上限`));
              req.destroy();
              return;
            }
            chunks.push(buf);
          });
          res.once('end', () => {
            resolve(Buffer.concat(chunks));
          });
          res.once('error', (err: Error) => reject(err));
        },
      );

      req.on('error', (err: Error) => reject(err));
      req.on('timeout', () => {
        req.destroy(new Error(`GPT-SoVITS ${method} ${path} 请求超时(${timeoutMs}ms)`));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

/**
 * 从 wav Buffer 估算音频时长(秒)
 * 假设 16kHz / 16bit / mono(GPT-SoVITS 默认输出格式)
 * 时长 = (总字节 - wav 头部长度) / (采样率 × 位深 / 8 × 通道数)
 * 容错:若解析失败,回退到粗略估算
 * @param buffer wav 字节流
 * @returns 时长(秒),无法解析时返回 0
 */
export function estimateWavDurationSec(buffer: Buffer): number {
  if (!buffer || buffer.length < 44) return 0;
  // 标准 wav 头部 RIFF////WAVE/fmt /
  // 采样率位于偏移 24,4 字节小端
  // 字节率位于偏移 28,4 字节小端(= sampleRate * channels * bitsPerSample/8)
  const byteRate = buffer.readUInt32LE(28);
  if (byteRate > 0) {
    // data 段从偏移 44 开始(标准 PCM wav)
    const dataBytes = Math.max(0, buffer.length - 44);
    return dataBytes / byteRate;
  }
  return 0;
}

/** GPT-SoVITS 客户端单例(全局复用) */
export const gptSoVitsClient = new GptSoVitsClient();
