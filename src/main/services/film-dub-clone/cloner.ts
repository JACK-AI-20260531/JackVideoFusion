/**
 * 节奏复刻引擎
 *
 * 职责:把 ShotMatch[] 合成为最终成片,复刻参考视频的镜头节奏
 *
 * 执行流程:
 *   1. 探测每个自有素材时长(缓存),按参考镜头 duration 计算安全切片范围
 *   2. 对每个匹配,用 ffmpegService.transcode(-ss/-t)从自有素材切出对应时长片段
 *   3. 用 ffmpegService.concat(filter 模式,兼容异源)拼接所有片段
 *   4. 应用 scale 滤镜统一比例(若不保留原画质)
 *   5. 若 generateTts:ttsService 合成配音音频 + SRT,并用 apad+shortest 混入视频
 *      (apad 把音频静音填充至与视频等长,-shortest 保证输出=视频时长,不破坏节奏)
 *   6. 若 subtitle.enabled:优先用 TTS SRT(时间轴对齐配音),否则按文案段落+镜头时长生成 SRT,
 *      调用 ffmpegService.burnSubtitle 烧录
 *   7. 若 watermark.enabled:调用 ffmpegService.applyWatermark
 *   8. 输出到 resolveExportPath(params.outputDir, params.outputName)
 *   9. 返回 CloneResult
 *
 * 节奏复刻要点:
 *   - 输出片段数 = 参考镜头数;每段时长 = 对应参考镜头 duration(不因配音时长覆盖)
 *   - 配音/字幕依附于视频时长,而非反过来,确保剪辑节奏与参考一致
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import { ffmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { TaskQueue } from '../task-queue';
import { ttsService } from '../tts';
import {
  buildScaleFilter,
  toFfmpegPosition,
  resolveExportPath,
} from '../common';
import { logger } from '../../utils/logger';
import type { SrtEntry } from '../tts';
import { formatSrtTime, serializeSrt } from '../tts';
import type { CloneParams, CloneResult, RhythmPattern, ShotMatch } from './types';

/** 默认 TTS 语音(zh-CN-XiaoxiaoNeural,中文女声) */
const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 片段时长下限(秒),防止极短镜头切出空片段 */
const MIN_CLIP_DURATION_SEC = 0.2;

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
 * 创建任务专用工作目录:userData/film-dub-clone-work/<taskId>/
 * @param taskId 任务 ID
 * @returns 工作目录绝对路径
 */
async function ensureWorkDir(taskId: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'film-dub-clone-work', taskId);
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
  watermark: NonNullable<CloneParams['watermark']>,
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
 * 把配音音频混入视频(保留视频时长,音频静音填充/截断对齐)
 * 使用 -af apad + -shortest:apad 把音频延展为无限,-shortest 在视频流结束时停止输出,
 * 从而保证输出时长 = 视频时长,不破坏镜头节奏。
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

  const cmd = ffmpeg();
  cmd.input(videoPath);
  cmd.input(audioPath);
  cmd.outputOptions([
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-af', 'apad',
    '-shortest',
  ]);
  cmd.output(output);

  logger.info(
    `[film-dub-clone/cloner] 合并配音: video=${videoPath} audio=${audioPath} -> ${output}`,
  );
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
 * 把文案按句号/换行/问号/感叹号切分为段落
 * 空段落会被过滤;若切分后只有一段,则返回单元素数组
 * @param script 原始文案
 * @returns 段落数组(已 trim,过滤空串)
 */
function splitParagraphs(script: string): string[] {
  if (!script) return [];
  const parts = script
    .split(/[。\n\r!?！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

/**
 * 按镜头时长分配文案段落,生成 SRT 字幕文件
 * 每个输出片段在成片中的时间轴 = 前序镜头 duration 累加;
 * 段落[i] 对应镜头[i];多余段落追加到最后一个镜头;段落不足则对应镜头无字幕。
 * @param matches 镜头匹配列表(按顺序)
 * @param script 解说文案
 * @param srtPath SRT 文件输出路径
 */
async function writeScriptSrt(
  matches: ShotMatch[],
  script: string,
  srtPath: string,
): Promise<void> {
  const paragraphs = splitParagraphs(script);
  const entries: SrtEntry[] = [];
  let cursorSec = 0;
  for (let i = 0; i < matches.length; i++) {
    const shotDur = Math.max(matches[i].shot.duration, MIN_CLIP_DURATION_SEC);
    const startSec = cursorSec;
    const endSec = startSec + shotDur;
    cursorSec = endSec;

    let text = paragraphs[i] ?? '';
    // 最后一个镜头:把剩余段落全部追加(避免文案丢失)
    if (i === matches.length - 1) {
      const extra = paragraphs.slice(i + 1).filter((p) => p.length > 0);
      if (extra.length > 0) {
        text = [text, ...extra].filter((t) => t.length > 0).join('。');
      }
    }
    if (text.trim().length === 0) continue;

    entries.push({
      index: entries.length + 1,
      startTime: formatSrtTime(startSec),
      endTime: formatSrtTime(endSec),
      text,
    });
  }
  await writeFile(srtPath, serializeSrt(entries), 'utf8');
}

/**
 * 计算素材切片的安全起点与时长
 * 当目标区间超出素材末尾时,把起点前移以尽量凑足 desired 时长;不足则取可用部分。
 * @param timeSec 匹配时间点(期望起点)
 * @param desiredDuration 期望切片时长(=参考镜头时长)
 * @param matDuration 素材总时长(秒)
 * @returns 安全起点与实际时长
 */
function computeClipRange(
  timeSec: number,
  desiredDuration: number,
  matDuration: number,
): { start: number; duration: number } {
  const desired = Math.max(desiredDuration, MIN_CLIP_DURATION_SEC);
  if (!matDuration || matDuration <= 0) {
    return { start: Math.max(0, timeSec), duration: desired };
  }
  const dur = Math.min(desired, matDuration);
  let start = Math.max(0, timeSec);
  if (start + dur > matDuration) {
    start = Math.max(0, matDuration - dur);
  }
  return { start, duration: dur };
}

/**
 * 执行节奏复刻合成
 *
 * @param matches 镜头匹配列表(由 matcher 产出,按参考镜头顺序)
 * @param rhythm 参考视频节奏特征
 * @param params 克隆参数
 * @param taskQueue 任务队列实例(用于 checkpoint 与进度推送)
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns 克隆结果
 */
export async function cloneVideo(
  matches: ShotMatch[],
  rhythm: RhythmPattern,
  params: CloneParams,
  taskQueue: TaskQueue,
  taskId: string,
  token: CancelToken,
): Promise<CloneResult> {
  logger.info(
    `[film-dub-clone/cloner] 任务 ${taskId} 开始合成: ${matches.length} 段`,
  );

  if (matches.length === 0) {
    throw new Error('[film-dub-clone/cloner] matches 为空,无法合成');
  }

  // ===== 1. 创建工作目录 =====
  const workDir = await ensureWorkDir(taskId);
  assertNotCancelled(token, taskId);

  // ===== 2. (可选)生成 TTS 配音 + SRT =====
  let ttsAudioPath: string | null = null;
  let ttsSrtPath: string | null = null;
  if (params.generateTts) {
    assertNotCancelled(token, taskId);
    ttsAudioPath = join(workDir, 'tts.mp3');
    ttsSrtPath = join(workDir, 'tts.srt');
    const ttsText = params.script || '';
    logger.info(`[film-dub-clone/cloner] 生成 TTS 配音: ${ttsText.length} 字符`);
    const ttsResult = await ttsService.synthesize({
      text: ttsText,
      voice: params.ttsVoice ?? DEFAULT_TTS_VOICE,
      outputPath: ttsAudioPath,
      srtPath: ttsSrtPath,
    });
    logger.info(
      `[film-dub-clone/cloner] TTS 完成: 时长 ${ttsResult.durationSec.toFixed(2)}s`,
    );
    taskQueue.saveCheckpoint(taskId, 'film-dub-tts', 56, {
      ttsAudioPath,
      ttsSrtPath,
      ttsDurationSec: ttsResult.durationSec,
    });
  }

  // ===== 3. 探测素材时长(缓存),切出每段片段 =====
  assertNotCancelled(token, taskId);
  const matDurationCache = new Map<string, number>();
  const clipPaths: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    assertNotCancelled(token, taskId);
    const m = matches[i];
    // 缓存素材时长
    let matDuration = matDurationCache.get(m.materialPath) ?? 0;
    if (!matDuration) {
      try {
        const meta = await ffmpegService.probe(m.materialPath);
        matDuration = meta.durationSec;
      } catch (err) {
        logger.warn(
          `[film-dub-clone/cloner] 探测素材时长失败,按无界处理: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        matDuration = 0;
      }
      matDurationCache.set(m.materialPath, matDuration);
    }

    const range = computeClipRange(m.timeSec, m.shot.duration, matDuration);
    const clipPath = join(workDir, `clip_${i}.mp4`);
    await ffmpegService.transcode(
      m.materialPath,
      clipPath,
      {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
        extraOutputOptions: [
          '-ss', String(range.start),
          '-t', String(range.duration),
        ],
      },
      token,
    );
    clipPaths.push(clipPath);

    // 切片阶段:56% → 76%
    const progress = 56 + 20 * ((i + 1) / matches.length);
    taskQueue.saveCheckpoint(taskId, 'film-dub-clip', progress, {
      clipIndex: i,
      clipPath,
    });
  }

  // ===== 4. 拼接所有片段(filter 模式,兼容异源) =====
  assertNotCancelled(token, taskId);
  const concatPath = join(workDir, 'concat.mp4');
  await ffmpegService.concat(clipPaths, concatPath, { mode: 'filter' }, token);
  let currentFile = concatPath;
  taskQueue.saveCheckpoint(taskId, 'film-dub-concat', 78, { currentFile });

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
    taskQueue.saveCheckpoint(taskId, 'film-dub-scale', 80, { currentFile });
  }

  // ===== 6. 合并 TTS 配音(若启用) =====
  assertNotCancelled(token, taskId);
  if (ttsAudioPath) {
    const mergedPath = join(workDir, 'with_tts.mp4');
    currentFile = await mergeTtsAudio(currentFile, ttsAudioPath, mergedPath, taskId, token);
    taskQueue.saveCheckpoint(taskId, 'film-dub-merge-tts', 85, { currentFile });
  }

  // ===== 7. 烧录字幕(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.subtitle?.enabled) {
    // 优先使用 TTS SRT(时间轴与配音对齐);无 TTS 时按文案段落+镜头时长生成
    let srtPath = ttsSrtPath;
    if (!srtPath) {
      srtPath = join(workDir, 'subtitle.srt');
      await writeScriptSrt(matches, params.script, srtPath);
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
    taskQueue.saveCheckpoint(taskId, 'film-dub-subtitle', 90, { currentFile });
  }

  // ===== 8. 应用水印(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.watermark?.enabled) {
    const wmOutput = join(workDir, 'watermarked.mp4');
    currentFile = await applyWatermarkIfNeeded(
      currentFile,
      wmOutput,
      params.watermark,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'film-dub-watermark', 94, { currentFile });
  }

  // ===== 9. 输出到最终路径 =====
  assertNotCancelled(token, taskId);
  const finalName = (params.outputName ?? `film-dub-clone-${Date.now()}.mp4`).trim();
  const finalPath = resolveExportPath(params.outputDir, finalName);
  await ffmpegService.transcode(
    currentFile,
    finalPath,
    { videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' },
    token,
  );

  // 探测最终时长
  const meta = await ffmpegService.probe(finalPath);

  taskQueue.saveCheckpoint(taskId, 'film-dub-finalize', 100, { finalPath });
  logger.info(
    `[film-dub-clone/cloner] 任务 ${taskId} 完成: ${finalPath}, 时长 ${meta.durationSec}s`,
  );

  return {
    outputPath: finalPath,
    durationSec: meta.durationSec,
    segmentCount: matches.length,
    rhythm,
  };
}
