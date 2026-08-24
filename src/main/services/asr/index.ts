/**
 * ASR 语音转写字幕服务入口
 *
 * 职责:把视频/音频中的人声识别为 SRT 字幕,作为「字幕提取」的语音识别模式。
 *
 * 主流程:
 *   1. probe 获取视频时长(校验输入有效)
 *   2. 用 engine.transcribe 识别音频,得到带时间戳的文本片段
 *   3. 用 FormatAsrSrt 把片段序列化为 SRT(复用 ocr/srt-builder 的 formatSrt)
 *   4. 写出 SRT 文件并返回路径
 *
 * 设计约定:
 *   - 复用 ffmpegService(engine 内部用 extractAudio 预处理音频)
 *   - ASR 引擎默认 WhisperAsrEngine(可注入便于扩展/测试)
 *   - 与 OCR 字幕提取(ocr/index.ts)同构,渲染层可在「字幕提取」页切换识别方式
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../utils/logger';
import { WhisperAsrEngine, type AsrEngine } from './engine';
import { ensureAsrModelDir } from './model-dir';
import { formatSrt } from '../ocr/srt-builder';
import type { AsrParams, AsrSegment, AsrProgressCallback, AsrRequest, AsrModelSize } from './types';

/** 默认模型规格 */
const DEFAULT_MODEL: AsrModelSize = 'base';
/** 临时音频工作目录前缀 */
const WORKDIR_PREFIX = 'asr-audio-';

/**
 * 生成唯一的临时工作目录
 * @returns 临时目录绝对路径
 */
function createWorkDir(): string {
  const dir = join(tmpdir(), `${WORKDIR_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把 ASR 片段序列化为 SRT 文本
 * 片段已带时间戳,直接映射为字幕行后复用 formatSrt
 * @param segments 识别片段(按 startSec 升序)
 * @returns SRT 内容
 */
export function serializeSegmentsToSrt(segments: AsrSegment[]): string {
  const lines = segments
    .map((s) => ({ startSec: s.startSec, endSec: Math.max(s.endSec, s.startSec + 0.1), text: s.text }))
    .filter((l) => l.text.trim().length > 0);
  return formatSrt(lines);
}

/**
 * ASR 字幕提取的外部依赖(可注入以便单测)
 */
export interface AsrDeps {
  /** 引擎工厂:根据模型规格与缓存目录创建 ASR 引擎 */
  createEngine?: (modelSize: AsrModelSize, cacheDir: string) => AsrEngine;
}

/**
 * ASR 语音转写 SRT 主流程
 * @param request 识别请求(参数 + 可选取消/进度)
 * @param deps 可选外部依赖注入(默认使用真实实现,便于单测注入 mock)
 * @returns 生成的 SRT 文件路径
 */
export async function extractSubtitleAsr(request: AsrRequest, deps: AsrDeps = {}): Promise<string> {
  const params = request.params;
  const token = request.token;
  const onProgress: AsrProgressCallback = request.onProgress ?? (() => {});
  const modelSize = params.modelSize ?? DEFAULT_MODEL;
  const createEngine = deps.createEngine ?? ((size, cacheDir) => new WhisperAsrEngine(size, cacheDir));

  const workDir = createWorkDir();
  // 准备模型缓存目录(transformers 会把模型下载/缓存到该目录)
  onProgress(0.05, '正在准备识别引擎');
  const cacheDir = ensureAsrModelDir();
  const engine = createEngine(modelSize, cacheDir);

  try {
    // ===== 1. 输入校验与会话日志 =====
    if (token?.cancelled) throw new Error('语音识别已取消');
    if (!params.videoPath) throw new Error('缺少音频/视频文件路径');
    logger.info(`[ASR] 开始语音识别: input=${params.videoPath} lang=${params.lang ?? 'auto'} model=${modelSize}`);

    // ===== 2. 加载引擎 =====
    onProgress(0.15, '正在加载识别模型');
    await engine.ensureReady();

    // ===== 3. 识别 =====
    onProgress(0.3, '正在识别语音');
    const segments = await engine.transcribe(params.videoPath, params.lang);

    if (token?.cancelled) throw new Error('语音识别已取消');
    if (segments.length === 0) {
      throw new Error('未识别到语音内容,可能音频过短或不清晰');
    }

    // ===== 4. 序列化 SRT =====
    onProgress(0.95, '正在生成字幕文件');
    const srt = serializeSegmentsToSrt(segments);
    // 确保输出目录存在
    mkdirSync(dirname(params.outputPath), { recursive: true });
    writeFileSync(params.outputPath, srt, 'utf8');

    onProgress(1, '完成');
    logger.info(`[ASR] 语音识别完成: 生成 ${segments.length} 条字幕 → ${params.outputPath}`);
    return params.outputPath;
  } finally {
    // 清理临时工作目录
    try {
      await engine.terminate();
    } catch {
      /* 忽略清理错误 */
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理错误 */
    }
  }
}
