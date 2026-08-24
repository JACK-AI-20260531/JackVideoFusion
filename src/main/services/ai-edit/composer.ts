/**
 * 成片合成引擎
 *
 * 职责:把 SceneMatch[] 合成为最终成片
 *
 * 执行流程:
 *   1. 对每个匹配,用 ffmpegService.transcode(-ss/-t)从源视频切出对应片段(前后各留 0.5s 余量)
 *   2. 用 ffmpegService.concat 拼接所有片段(filter 模式,兼容异源)
 *   3. 应用 scale 滤镜统一比例(若不保留原画质)
 *   4. 若 generateTts:调用 ttsService 合成配音音频 + SRT
 *   5. 若 generateTts:用 fluent-ffmpeg 把配音音频混入视频(-shortest 对齐)
 *   6. 若 subtitle.enabled:用文案段落生成 SRT,调用 ffmpegService.burnSubtitle
 *      (若已生成 TTS SRT,优先使用 TTS SRT,因时间轴与配音对齐)
 *   7. 若 watermark.enabled:调用 ffmpegService.applyWatermark
 *   8. 输出到 resolveExportPath(params.outputDir, params.outputName)
 *   9. 返回 AiEditResult
 *
 * 复用约定:
 *   - 视频切分/拼接/水印/字幕/转码:全部走 ffmpegService
 *   - 音视频合并(fluent-ffmpeg 多输入):参照 audio-matcher.ts 同样的封装模式
 *   - 不直接 spawn ffmpeg 子进程
 */
import { app } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import { ffmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import { taskQueue } from '../task-queue';
import { ttsService } from '../tts';
import {
  buildScaleFilter,
  toFfmpegPosition,
  resolveExportPath,
} from '../common';
import { logger } from '../../utils/logger';
import type { SrtEntry } from '../tts';
import { formatSrtTime, serializeSrt } from '../tts';
import type { AiEditParams, AiEditResult, SceneMatch } from './types';

/** 切片前后余量(秒):每段前后各留 0.5s 余量,避免关键帧对齐导致画面跳变 */
const CLIP_PADDING_SEC = 0.5;

/** 默认 TTS 语音(zh-CN-XiaoxiaoNeural,中文女声) */
const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural';

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 创建任务专用工作目录:userData/ai-edit-work/<taskId>/
 * @param taskId 任务 ID
 * @returns 工作目录绝对路径
 */
async function ensureWorkDir(taskId: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'ai-edit-work', taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 把通用 WatermarkConfig 转换为 ffmpeg WatermarkOpts 并应用
 * @param input 输入视频
 * @param output 输出视频
 * @param watermark 水印配置
 * @param token 取消令牌
 * @returns 输出视频路径
 */
async function applyWatermarkIfNeeded(
  input: string,
  output: string,
  watermark: NonNullable<AiEditParams['watermark']>,
  token: CancelToken,
): Promise<string> {
  if (watermark.type === 'image') {
    return ffmpegService.applyWatermark(
      input,
      output,
      {
        type: 'image',
        image: watermark.content,
        position: toFfmpegPosition(watermark.position),
        marginX: watermark.marginX,
        marginY: watermark.marginY,
        scale: watermark.scale,
      },
      token,
    );
  }
  return ffmpegService.applyWatermark(
    input,
    output,
    {
      type: 'text',
      text: watermark.content,
      position: toFfmpegPosition(watermark.position),
      marginX: watermark.marginX,
      marginY: watermark.marginY,
      fontSize: watermark.fontSize,
      fontColor: watermark.fontColor,
      fontFile: watermark.fontFile,
    },
    token,
  );
}

/**
 * 把配音音频混入视频(替换原音轨)
 * 使用 fluent-ffmpeg 多输入模式:-map 0:v -map 1:a -shortest 对齐时长
 * 参照 audio-matcher.ts 的 mergeAudioVideo 实现模式
 * @param videoPath 视频文件路径
 * @param audioPath 配音音频路径
 * @param output 输出文件路径
 * @param taskId 任务 ID(用于错误信息)
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function mergeTtsAudio(
  videoPath: string,
  audioPath: string,
  output: string,
  taskId: string,
  token: CancelToken,
): Promise<string> {
  assertNotCancelled(token, taskId);

  // 用 fluent-ffmpeg 直接构建命令(多输入场景,ffmpegService.transcode 单输入不适用)
  const cmd = ffmpeg();
  cmd.input(videoPath);
  cmd.input(audioPath);
  // 映射:取视频流 + 音频流,视频流复制,音频流转码为 aac
  cmd.outputOptions([
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
  ]);
  cmd.output(output);

  logger.info(`[ai-edit/composer] 合并配音: video=${videoPath} audio=${audioPath} -> ${output}`);
  await new Promise<void>((resolve, reject) => {
    if (token.cancelled) {
      reject(new FFmpegError('任务已取消', { code: 'CANCELLED', taskId }));
      return;
    }
    cmd
      .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
        if (token.cancelled) {
          reject(new FFmpegError('任务已取消', { code: 'CANCELLED', taskId, stderr: stderr ?? undefined }));
        } else {
          reject(
            new FFmpegError(err.message, {
              code: 'FFMPEG_RUN_ERROR',
              stderr: stderr ?? undefined,
              taskId,
            }),
          );
        }
      })
      .on('end', () => resolve())
      .run();
  });
  return output;
}

/**
 * 按段落时长生成 SRT 字幕文件
 * 每段字幕时长 = 该段对应视频片段的 segmentSec,时间轴累加
 * @param matches 场景匹配列表(已按段落顺序)
 * @param srtPath SRT 文件输出路径
 */
async function writeParagraphSrt(matches: SceneMatch[], srtPath: string): Promise<void> {
  const entries: SrtEntry[] = [];
  let cursorSec = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const startSec = cursorSec;
    const endSec = startSec + Math.max(m.segmentSec, 1.0);
    cursorSec = endSec;
    entries.push({
      index: i + 1,
      startTime: formatSrtTime(startSec),
      endTime: formatSrtTime(endSec),
      text: m.paragraph,
    });
  }
  await writeFile(srtPath, serializeSrt(entries), 'utf8');
}

/**
 * 把单条文案所有段落拼接为完整文本(用于 TTS 输入)
 * @param matches 场景匹配列表
 * @returns 拼接后的完整文案
 */
export function joinParagraphs(matches: SceneMatch[]): string {
  return matches.map((m) => m.paragraph).join('。');
}

/**
 * 执行成片合成
 *
 * @param matches 场景匹配列表(由 matcher 产出,按段落顺序)
 * @param keywords 关键词列表(用于结果返回)
 * @param params AI 剪辑参数
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns AI 剪辑结果
 */
export async function composeVideo(
  matches: SceneMatch[],
  keywords: string[],
  params: AiEditParams,
  taskId: string,
  token: CancelToken,
): Promise<AiEditResult> {
  logger.info(`[ai-edit/composer] 任务 ${taskId} 开始合成: ${matches.length} 段`);

  if (matches.length === 0) {
    throw new Error('[ai-edit/composer] matches 为空,无法合成');
  }

  // ===== 1. 创建工作目录 =====
  const workDir = await ensureWorkDir(taskId);
  assertNotCancelled(token, taskId);

  // ===== 2. (可选)生成 TTS 配音 + SRT =====
  let ttsAudioPath: string | null = null;
  let ttsSrtPath: string | null = null;
  let ttsDurationSec = 0;

  // 断点续渲染:加载 checkpoint 确定跳过哪些已完成的合成阶段
  let skipTts = false;        // 跳过 TTS 生成(已生成)
  let skipClips = false;      // 跳过逐段切片与 concat
  let skipScale = false;      // 跳过 scale 转码
  let skipMergeTts = false;   // 跳过 TTS 合并
  let skipSubtitle = false;   // 跳过程序烧录
  let skipWatermark = false;  // 跳过水印
  let currentFileOverride = ''; // 已产出的中间文件,作为后续阶段输入
  const cp = taskQueue.loadCheckpoint(taskId);
  if (cp) {
    const ctx = cp.context as Record<string, unknown>;
    const existsFile = (f: unknown): f is string =>
      typeof f === 'string' && f.length > 0 && existsSync(f);
    if (cp.step === 'ai-edit-finalize' && existsFile(ctx.finalPath)) {
      logger.info(`[ai-edit/composer] 任务 ${taskId} checkpoint=finalize,直接返回`);
      const meta = await ffmpegService.probe(ctx.finalPath);
      return {
        outputPath: ctx.finalPath,
        durationSec: meta.durationSec,
        segmentCount: matches.length,
        keywords,
      };
    }
    if (cp.step === 'ai-edit-watermark' && existsFile(ctx.currentFile)) {
      skipTts = skipClips = skipScale = skipMergeTts = skipSubtitle = true;
      currentFileOverride = ctx.currentFile;
    } else if (cp.step === 'ai-edit-subtitle' && existsFile(ctx.currentFile)) {
      skipTts = skipClips = skipScale = skipMergeTts = skipSubtitle = true;
      currentFileOverride = ctx.currentFile;
    } else if (cp.step === 'ai-edit-merge-tts' && existsFile(ctx.currentFile)) {
      skipTts = skipClips = skipScale = skipMergeTts = true;
      currentFileOverride = ctx.currentFile;
    } else if (cp.step === 'ai-edit-scale' && existsFile(ctx.currentFile)) {
      skipTts = skipClips = skipScale = true;
      currentFileOverride = ctx.currentFile;
    } else if (cp.step === 'ai-edit-concat' && existsFile(ctx.currentFile)) {
      skipTts = skipClips = true;
      currentFileOverride = ctx.currentFile;
    } else if (cp.step === 'ai-edit-tts' && existsFile(ctx.ttsAudioPath)) {
      // 仅跳过 TTS,后续切片全新执行(clip 阶段依靠 existsSync 逐片自跳过)
      skipTts = true;
      ttsAudioPath = ctx.ttsAudioPath;
      ttsSrtPath = (ctx.ttsSrtPath as string) || null;
      ttsDurationSec = Number(ctx.ttsDurationSec ?? 0);
    }
    if (currentFileOverride) {
      logger.info(`[ai-edit/composer] 任务 ${taskId} 从 checkpoint(step=${cp.step})续渲染`);
    }
  }

  if (params.generateTts && !skipTts) {
    assertNotCancelled(token, taskId);
    ttsAudioPath = join(workDir, 'tts.mp3');
    ttsSrtPath = join(workDir, 'tts.srt');
    const ttsText = joinParagraphs(matches);
    logger.info(`[ai-edit/composer] 生成 TTS 配音: ${ttsText.length} 字符`);
    const ttsResult = await ttsService.synthesize({
      text: ttsText,
      voice: params.ttsVoice ?? DEFAULT_TTS_VOICE,
      outputPath: ttsAudioPath,
      srtPath: ttsSrtPath,
    });
    ttsDurationSec = ttsResult.durationSec;
    logger.info(`[ai-edit/composer] TTS 完成: 时长 ${ttsDurationSec.toFixed(2)}s`);
    taskQueue.saveCheckpoint(taskId, 'ai-edit-tts', 5, {
      ttsAudioPath,
      ttsSrtPath,
      ttsDurationSec,
    });

    // 若有配音,按配音时长分配各段 segmentSec(简化:平均分配)
    if (ttsDurationSec > 0) {
      const avgSec = ttsDurationSec / matches.length;
      for (const m of matches) {
        m.segmentSec = Number(avgSec.toFixed(2));
      }
    }
  }

  // ===== 3. 从源视频切出每段片段 =====
  assertNotCancelled(token, taskId);
  const clipPaths: string[] = [];
  // 若从中间阶段续跑,跳过整个切片循环
  if (!skipClips) {
    for (let i = 0; i < matches.length; i++) {
      assertNotCancelled(token, taskId);
      const m = matches[i];
      const clipPath = join(workDir, `clip_${i}.mp4`);
      // 断点续渲染:片段已产出则直接跳过切分
      if (existsSync(clipPath)) {
        clipPaths.push(clipPath);
        continue;
      }
      // 切片起点 = 匹配时间 - 余量(下限 0)
      const startTime = Math.max(0, m.timeSec - CLIP_PADDING_SEC);
      // 切片时长 = 段时长 + 2 * 余量
      const duration = m.segmentSec + 2 * CLIP_PADDING_SEC;
      // 用 transcode + extraOutputOptions(-ss/-t)从源视频精确切出片段
      await ffmpegService.transcode(
        m.videoPath,
        clipPath,
        {
          videoCodec: 'libx264',
          audioCodec: 'aac',
          preset: 'medium',
          extraOutputOptions: ['-ss', String(startTime), '-t', String(duration)],
        },
        token,
      );
      clipPaths.push(clipPath);

      // 切片阶段:5% → 35%(若有 TTS)或 10% → 50%(无 TTS)
      const baseProgress = params.generateTts ? 5 : 10;
      const rangeProgress = params.generateTts ? 30 : 40;
      const progress = baseProgress + rangeProgress * ((i + 1) / matches.length);
      taskQueue.saveCheckpoint(taskId, 'ai-edit-clip', progress, {
        clipIndex: i,
        clipPath,
      });
    }
  }

  // ===== 4. 拼接所有片段(filter 模式,兼容异源) =====
  assertNotCancelled(token, taskId);
  let currentFile: string;
  if (currentFileOverride) {
    // 从已产出的中间文件续跑,跳过 concat
    currentFile = currentFileOverride;
  } else {
    const concatPath = join(workDir, 'concat.mp4');
    await ffmpegService.concat(clipPaths, concatPath, { mode: 'filter' }, token);
    currentFile = concatPath;
  }
  taskQueue.saveCheckpoint(taskId, 'ai-edit-concat', 55, { currentFile });

  // ===== 5. 应用 scale 滤镜统一比例(若不保留原画质) =====
  assertNotCancelled(token, taskId);
  const scaleFilter = buildScaleFilter(params.resolution, params.keepOriginalQuality);
  if (scaleFilter.length > 0) {
    const scaledPath = join(workDir, 'scaled.mp4');
    await ffmpegService.transcode(
      currentFile,
      scaledPath,
      {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
        extraOutputOptions: ['-vf', scaleFilter],
      },
      token,
    );
    currentFile = scaledPath;
    taskQueue.saveCheckpoint(taskId, 'ai-edit-scale', 60, { currentFile });
  }

  // ===== 6. 合并 TTS 配音(若启用) =====
  assertNotCancelled(token, taskId);
  if (ttsAudioPath && !skipMergeTts) {
    const mergedPath = join(workDir, 'with_tts.mp4');
    currentFile = await mergeTtsAudio(currentFile, ttsAudioPath, mergedPath, taskId, token);
    taskQueue.saveCheckpoint(taskId, 'ai-edit-merge-tts', 70, { currentFile });
  }

  // ===== 7. 烧录字幕(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.subtitle?.enabled && !skipSubtitle) {
    // 优先使用 TTS SRT(时间轴与配音对齐);无 TTS 时按段落时长生成
    let srtPath = ttsSrtPath;
    if (!srtPath) {
      srtPath = join(workDir, 'subtitle.srt');
      await writeParagraphSrt(matches, srtPath);
    }
    const subOutput = join(workDir, 'subtitle.mp4');
    currentFile = await ffmpegService.burnSubtitle(
      currentFile,
      subOutput,
      {
        subtitlePath: srtPath,
        fontSize: params.subtitle.style?.fontSize,
        forceStyle: !!params.subtitle.style,
      },
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'ai-edit-subtitle', 80, { currentFile });
  }

  // ===== 8. 应用水印(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.watermark?.enabled && !skipWatermark) {
    const wmOutput = join(workDir, 'watermarked.mp4');
    currentFile = await applyWatermarkIfNeeded(
      currentFile,
      wmOutput,
      params.watermark,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'ai-edit-watermark', 90, { currentFile });
  }

  // ===== 9. 输出到最终路径 =====
  assertNotCancelled(token, taskId);
  const finalName = (params.outputName ?? `ai-edit-${Date.now()}.mp4`).trim();
  const finalPath = resolveExportPath(params.outputDir, finalName);
  // 通过 transcode 重封装到最终路径(确保格式标准 + 跨卷安全)
  await ffmpegService.transcode(
    currentFile,
    finalPath,
    { videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' },
    token,
  );

  // 探测最终时长
  const meta = await ffmpegService.probe(finalPath);

  taskQueue.saveCheckpoint(taskId, 'ai-edit-finalize', 100, { finalPath });
  logger.info(
    `[ai-edit/composer] 任务 ${taskId} 完成: ${finalPath}, 时长 ${meta.durationSec}s`,
  );

  return {
    outputPath: finalPath,
    durationSec: meta.durationSec,
    segmentCount: matches.length,
    keywords,
  };
}
