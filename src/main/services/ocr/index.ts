/**
 * OCR 字幕识别服务入口
 *
 * 职责:把视频画面中的文字(烧录字幕)识别为 SRT 字幕,作为"无内嵌字幕流"
 *      时的兜底方案。
 *
 * 主流程:
 *   1. probe 获取视频时长
 *   2. 用 ffmpegService.extractFrames 按间隔抽帧
 *   3. 逐帧送入 OCR 引擎识别文字,关联时间戳
 *   4. 用 srt-builder 合并连续相似文本为字幕段
 *   5. 序列化 SRT 并写入输出文件,返回路径
 *
 * 设计约定:
 *   - 复用 ffmpegService 的 probe/extractFrames,避免重复实现
 *   - OCR 引擎默认 TesseractOcrEngine(可注入便于扩展)
 *   - 临时抽帧目录默认 os.tmpdir(),用后清理
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { ffmpegService } from '../ffmpeg';
import type { VideoMeta, CancelToken } from '../ffmpeg/types';
import { logger } from '../../utils/logger';
import { TesseractOcrEngine, type OcrEngine } from './engine';
import { ensureLangReady } from './lang-store';
import { resolveFrameInterval } from './interval';
import { buildSubtitleLines, formatSrt } from './srt-builder';
import type { OcrParams, OcrRequest, OcrProgressCallback, FrameOcrResult } from './types';

/** 默认抽帧间隔(秒) */
const DEFAULT_INTERVAL = 1;
/** 默认 OCR 语言 */
const DEFAULT_LANG = 'chi_sim';
/** 默认抽帧宽度(px) */
const DEFAULT_FRAME_WIDTH = 1280;

/** 抽帧临时目录前缀 */
const WORKDIR_PREFIX = 'ocr-frames-';

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
 * 根据抽帧索引与间隔推导该帧对应的视频时间点(秒)
 * 第一帧(索引 0)对应第 1 个间隔处,以此类推
 * @param index 帧序号(从 0 开始)
 * @param intervalSec 抽帧间隔(秒)
 * @returns 时间点(秒)
 */
function frameTimeSec(index: number, intervalSec: number): number {
  return (index + 1) * intervalSec;
}

/**
 * OCR 字幕提取主流程
 * @param request 识别请求(参数 + 可选取消/进度)
 * @returns 生成的 SRT 文件路径
 */
export async function extractSubtitleOcr(request: OcrRequest): Promise<string> {
  const params = request.params;
  const token = request.token;
  const onProgress: OcrProgressCallback = request.onProgress ?? (() => {});

  const interval = params.intervalSec && params.intervalSec > 0 ? params.intervalSec : DEFAULT_INTERVAL;
  const lang = params.lang ?? DEFAULT_LANG;
  const frameWidth = params.frameWidth && params.frameWidth > 0 ? params.frameWidth : DEFAULT_FRAME_WIDTH;

  const workDir = createWorkDir();
  // 确保语言包本地就绪(缺失则下载),返回本地语言包目录
  onProgress(0.05, '正在准备识别引擎');
  const langDir = await ensureLangReady(lang);
  const engine: OcrEngine = new TesseractOcrEngine(lang, langDir);

  try {
    // ===== 1. 探测时长 =====
    if (token?.cancelled) throw new Error('OCR 字幕识别已取消');
    const meta: VideoMeta = await ffmpegService.probe(params.videoPath);
    const durationSec = meta.durationSec > 0 ? meta.durationSec : 0;
    if (durationSec <= 0) {
      throw new Error(`无法读取视频时长: ${params.videoPath}`);
    }

    // 抽帧间隔自适应:若按默认间隔会超出最大抽帧上限,则增大间隔以控制总帧数
    const effectiveInterval = resolveFrameInterval(durationSec, interval, params.maxFrames);
    logger.info(
      `[OCR] 视频时长 ${durationSec}s,抽帧间隔 ${effectiveInterval.toFixed(2)}s(原始 ${interval}s),` +
      `预计 ${Math.ceil(durationSec / effectiveInterval)} 帧,语言 ${lang}`,
    );

    // ===== 2. 抽帧 =====
    onProgress(0.1, '正在抽帧');
    const framePaths = await ffmpegService.extractFrames(
      params.videoPath,
      workDir,
      { mode: 'interval', value: effectiveInterval, prefix: 'ocr_', format: 'png', width: frameWidth },
      token,
    );
    if (framePaths.length === 0) {
      throw new Error('未抽取到任何视频帧');
    }

    // ===== 3. 逐帧识别 =====
    onProgress(0.2, '正在初始化识别引擎');
    await engine.ensureReady();
    const frameResults: FrameOcrResult[] = [];
    const total = framePaths.length;
    for (let i = 0; i < total; i++) {
      if (token?.cancelled) throw new Error('OCR 字幕识别已取消');
      const text = await engine.recognize(framePaths[i]);
      frameResults.push({ timeSec: frameTimeSec(i, effectiveInterval), text });
      // 进度:抽帧 0.1~0.2 + 识别 0.2~0.9
      onProgress(0.2 + (0.7 * (i + 1)) / total, `正在识别文字 ${i + 1}/${total}`);
    }

    // ===== 4. 合并为字幕段 =====
    onProgress(0.93, '正在合并字幕');
    const lines = buildSubtitleLines(frameResults, {
      intervalSec: effectiveInterval,
      minDurationSec: params.minDurationSec,
      similarityThreshold: params.similarityThreshold,
    });
    if (lines.length === 0) {
      throw new Error('未识别到画面文字,可能画面无字幕或文字不清晰');
    }

    // ===== 5. 写出 SRT =====
    onProgress(0.97, '正在写入字幕文件');
    const srt = formatSrt(lines);
    // 确保输出目录存在
    mkdirSync(dirname(params.outputPath), { recursive: true });
    writeFileSync(params.outputPath, srt, 'utf8');

    onProgress(1, '完成');
    logger.info(`[OCR] 字幕识别完成: 生成 ${lines.length} 条字幕 → ${params.outputPath}`);
    return params.outputPath;
  } finally {
    // 清理临时帧目录
    try {
      await engine.terminate();
    } catch {
      /* 忽略清理错误 */
    }
    try {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理错误 */
    }
  }
}
