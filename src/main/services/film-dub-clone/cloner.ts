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
import {
  assignShotScripts,
  computeRateForMatch,
  calculateRateCorrection,
} from './segment-script';
import type { CloneParams, CloneResult, RhythmPattern, ShotMatch } from './types';

/** 默认 TTS 语音(zh-CN-XiaoxiaoNeural,中文女声) */
const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 片段时长下限(秒),防止极短镜头切出空片段 */
const MIN_CLIP_DURATION_SEC = 0.2;

/** 逐镜头配音生成时,时长误差在此容差内视为"已卡准镜头" */
const RATE_TOLERANCE_SEC = 0.5;

/** 逐镜头配音重合成的最大尝试次数(含初次合成),超过则接受当前结果避免无限重试 */
const MAX_TTS_ATTEMPTS = 3;

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
 * 把多段配音音频按镜头时间轴对齐合并
 * 每段音频用 adelay 延迟到其所在镜头的起点,再 amix 混合为一条完整音轨。
 * 因逐镜头语速已自适应,相邻段基本无缝衔接;空镜头时间段自然留白。
 * @param segments 待合并的音频段(含延迟起点)
 * @param output 输出音频文件路径
 * @param taskId 任务 ID(用于取消/错误)
 * @param token 取消令牌
 * @returns 合并后的音频文件路径
 */
async function mergeSegmentAudios(
  segments: { audioPath: string; delaySec: number }[],
  output: string,
  taskId: string,
  token: CancelToken,
): Promise<string> {
  assertNotCancelled(token, taskId);
  if (segments.length === 0) {
    throw new Error('[film-dub-clone/cloner] mergeSegmentAudios 输入为空');
  }

  // 单段:直接重封装(复制编码),避免无谓的滤镜重编码
  if (segments.length === 1) {
    await ffmpegService.remux(segments[0].audioPath, output, { format: 'mp3' }, token);
    return output;
  }

  const cmd = ffmpeg();
  for (const seg of segments) cmd.input(seg.audioPath);

  const filters: string[] = [];
  // 每路 adelay 延迟到镜头起点(all=1 表示所有声道统一延迟)
  for (let i = 0; i < segments.length; i++) {
    const delayMs = Math.round(segments[i].delaySec * 1000);
    filters.push(`[${i}:a]adelay=${delayMs}:all=1[a${i}]`);
  }
  // amix 混合全部延迟流,duration=longest 取最长音频为总时长
  const inLabels = segments.map((_, i) => `[a${i}]`).join('');
  filters.push(`${inLabels}amix=inputs=${segments.length}:duration=longest[aout]`);

  cmd.complexFilter(filters);
  cmd.outputOptions(['-map', '[aout]', '-c:a', 'libmp3lame', '-q:a', '4']);
  cmd.output(output);

  logger.info(
    `[film-dub-clone/cloner] 合并 ${segments.length} 段配音: ${segments.length} 段 -> ${output}`,
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
 * 按"逐镜头脚本"生成 SRT 字幕文件
 * 时间轴严格等于镜头时间轴(由 assignShotScripts 算出的 startSec/durationSec),
 * 空字幕镜头跳过,保证字幕与逐镜头配音对齐。
 * @param scripts 逐镜头脚本分配结果(由 assignShotScripts 产出)
 * @param srtPath SRT 文件输出路径
 */
async function writeShotScriptSrt(
  scripts: { index: number; text: string; startSec: number; durationSec: number }[],
  srtPath: string,
): Promise<void> {
  const entries: SrtEntry[] = [];
  for (const seg of scripts) {
    const text = seg.text.trim();
    if (text.length === 0) continue;
    const startSec = seg.startSec;
    const endSec = startSec + Math.max(seg.durationSec, MIN_CLIP_DURATION_SEC);
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

  // ===== 2. (可选)逐镜头生成 TTS 配音 + 分段字幕 =====
  // 先按镜头时长分配文案段落,得到逐镜头脚本(时间轴 = 镜头累加)
  const shotScripts = assignShotScripts(
    params.script || '',
    matches.map((m) => m.shot.duration),
  );

  let ttsAudioPath: string | null = null;
  let ttsSrtPath: string | null = null;
  if (params.generateTts) {
    assertNotCancelled(token, taskId);
    const voiced = shotScripts.filter((s) => s.text.trim().length > 0);
    const ttsVoice = params.ttsVoice ?? DEFAULT_TTS_VOICE;
    logger.info(
      `[film-dub-clone/cloner] 逐镜头生成 TTS 配音: ${voiced.length}/${shotScripts.length} 段有配音`,
    );

    if (voiced.length > 0) {
      const segAudios: { audioPath: string; delaySec: number }[] = [];
      for (let i = 0; i < voiced.length; i++) {
        assertNotCancelled(token, taskId);
        const seg = voiced[i];
        const segAudio = join(workDir, `seg_tts_${seg.index}.mp3`);
        // 目标时长 = 镜头时长(至少 MIN_CLIP_DURATION_SEC)
        const targetSec = Math.max(seg.durationSec, MIN_CLIP_DURATION_SEC);
        // 初始语速:由"内容感知"时长估算模型给出
        let rate = computeRateForMatch(seg.text, targetSec);

        // 初次合成
        let synth = await ttsService.synthesize({
          text: seg.text,
          voice: ttsVoice,
          rate,
          outputPath: segAudio,
        });

        // 双向迭代收敛:配音过长则加快、过短则放慢,直到贴近镜头时长或达到尝试上限。
        // 用 calculateRateCorrection 按"实际/目标"比例纠偏,收敛更快;rate 不再变化即停止。
        let attempts = 1;
        while (
          attempts < MAX_TTS_ATTEMPTS &&
          !token.cancelled &&
          Math.abs(synth.durationSec - targetSec) > RATE_TOLERANCE_SEC
        ) {
          const nextRate = calculateRateCorrection(rate, synth.durationSec, targetSec);
          if (nextRate === rate) break; // rate 已收敛到边界,避免死循环
          rate = nextRate;
          attempts++;
          logger.info(
            `[film-dub-clone/cloner] 段 ${seg.index} 配音 ${synth.durationSec.toFixed(2)}s ` +
              `vs 镜头 ${targetSec.toFixed(2)}s,按比例纠偏后重合成 rate=${rate}`,
          );
          synth = await ttsService.synthesize({
            text: seg.text,
            voice: ttsVoice,
            rate,
            outputPath: segAudio,
          });
        }

        segAudios.push({ audioPath: segAudio, delaySec: seg.startSec });

        // 逐镜头进度:56% → 66%
        const progress = 56 + 10 * ((i + 1) / voiced.length);
        taskQueue.saveCheckpoint(taskId, 'film-dub-seg-tts', progress, {
          segIndex: seg.index,
          segAudio,
          durationSec: synth.durationSec,
        });
      }

      // 按镜头时间轴对齐合并所有段
      ttsAudioPath = join(workDir, 'tts_merged.mp3');
      await mergeSegmentAudios(segAudios, ttsAudioPath, taskId, token);
      logger.info(`[film-dub-clone/cloner] 分段配音已合并: ${ttsAudioPath}`);

      // 生成分段字幕(时间轴 = 镜头轴,空镜头跳过)
      ttsSrtPath = join(workDir, 'tts_segments.srt');
      await writeShotScriptSrt(shotScripts, ttsSrtPath);
      taskQueue.saveCheckpoint(taskId, 'film-dub-tts', 56, {
        ttsAudioPath,
        ttsSrtPath,
        segmentCount: segAudios.length,
      });
    }
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

  // ===== 4. 拼接所有片段 =====
  // transitionSec>0 时启用 xfade 链式转场(含音频 acrossfade),否则 filter 硬切(兼容异源)
  assertNotCancelled(token, taskId);
  const concatPath = join(workDir, 'concat.mp4');
  const transitionSec = params.transitionSec ?? 0;
  await ffmpegService.concat(
    clipPaths,
    concatPath,
    {
      mode: 'filter',
      transitionSec: transitionSec > 0 ? transitionSec : undefined,
      transition: transitionSec > 0 ? 'fade' : undefined,
    },
    token,
  );
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
    // 生成逐镜头字幕(时间轴 = 镜头轴,与分段配音严格对齐);空字幕镜头跳过
    const srtPath = join(workDir, 'subtitle.srt');
    await writeShotScriptSrt(shotScripts, srtPath);
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
