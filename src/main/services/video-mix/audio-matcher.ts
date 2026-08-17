/**
 * 文件夹音频匹配(模式二)实现
 *
 * 职责:每个文件夹独立抽取 1 条音频 + N 条视频 → 合成为片段 → 全部片段再拼接为最终视频
 *
 * 文件夹隔离硬约束:
 *   - 全程只对单个 folderId 调用 pickFromFolder,绝不跨文件夹
 *   - 每个文件夹产出一个独立的"视频+音频"合成片段
 *   - 最后把所有独立片段 concat 成一个总视频(此步是片段级拼接,非素材级跨文件夹抽取)
 *
 * 执行流程:
 *   1. 对每个 folderId(独立子任务):
 *      a. scanFolder 刷新素材
 *      b. pickFromFolder(folderId, 1, {kind:'audio'}) 抽 1 条音频
 *      c. pickFromFolder(folderId, N, {kind:'video', unique:true}) 抽 N 条视频
 *      d. 若 stripOriginalAudio:对视频分段 stripAudio
 *      e. concat 拼接视频分段(filter 模式)
 *      f. 把音频与视频合成(audioLoop 时循环音频;audioFadeSec 应用淡入淡出)
 *      g. 应用 scale 统一比例
 *   2. 把所有文件夹产出的独立片段 concat 成最终视频
 *   3. 应用 watermark / subtitle 后处理(同模式一)
 *   4. 每个原子步骤后保存 checkpoint
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import ffmpeg from 'fluent-ffmpeg';
import { ffmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import { materialRepo } from '../material-repo';
import type { MaterialMeta } from '@shared/types';
import { taskQueue } from '../task-queue';
import {
  buildScaleFilter,
  toFfmpegPosition,
  resolveExportPath,
} from '../common';
import { logger } from '../../utils/logger';
import type { MixParams, MixResult } from './types';

/**
 * 创建任务专用工作目录
 * @param taskId 任务 ID
 * @returns 工作目录绝对路径
 */
async function ensureWorkDir(taskId: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'video-mix-work', taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

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
  watermark: NonNullable<MixParams['watermark']>,
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
 * 烧录字幕(若配置)
 * @param input 输入视频
 * @param output 输出视频
 * @param subtitle 字幕配置
 * @param token 取消令牌
 * @returns 输出视频路径
 */
async function burnSubtitleIfNeeded(
  input: string,
  output: string,
  subtitle: NonNullable<MixParams['subtitle']>,
  token: CancelToken,
): Promise<string> {
  return ffmpegService.burnSubtitle(
    input,
    output,
    {
      subtitlePath: subtitle.srtPath,
      fontSize: subtitle.style?.fontSize,
      forceStyle: !!subtitle.style,
    },
    token,
  );
}

/**
 * 把单条音频与拼接好的视频合成
 * - audioLoop=true 且音频短于视频:循环音频以适配视频时长
 * - audioFadeSec>0:对音频应用淡入(st=0)+ 淡出(st=duration-fadeSec)双段 afade 滤镜
 * - 使用 ffmpeg -map 选择视频流和音频流,避免复杂滤镜
 * @param videoPath 视频文件路径
 * @param audioPath 音频文件路径
 * @param output 输出文件路径
 * @param opts 音频处理选项
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function mergeAudioVideo(
  videoPath: string,
  audioPath: string,
  output: string,
  opts: { audioLoop: boolean; audioFadeSec: number },
  token: CancelToken,
): Promise<string> {
  assertNotCancelled(token, '');
  const taskId = token.id;

  // 构造音频滤镜链:循环(可选)→ 淡入 + 淡出(可选)
  // 注意:loop 滤镜需要 -stream_loop -1 输入选项配合;此处简化为使用 aloop 滤镜
  // 实际上对于"音频适配视频时长",更稳健的做法是 -stream-loop -1 + -shortest
  const audioFilters: string[] = [];
  if (opts.audioFadeSec > 0) {
    // 淡入:从 0 秒开始,持续 fadeSec
    audioFilters.push(`afade=t=in:st=0:d=${opts.audioFadeSec}`);
    // 淡出:需要预知最终时长;用视频时长作为最终时长(配合 -shortest)
    // st = max(0, videoDuration - fadeSec),确保淡出在视频结束前 fadeSec 秒开始
    try {
      const videoMeta = await ffmpegService.probe(videoPath);
      const fadeOutStart = Math.max(0, videoMeta.durationSec - opts.audioFadeSec);
      audioFilters.push(
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${opts.audioFadeSec}`,
      );
      logger.info(
        `[audio-matcher] 任务 ${taskId} 音频淡入淡出: in 0~${opts.audioFadeSec}s, out ${fadeOutStart.toFixed(3)}~${videoMeta.durationSec.toFixed(3)}s`,
      );
    } catch (err) {
      // probe 失败时仅做淡入,保证合成不阻塞
      logger.warn(
        `[audio-matcher] 任务 ${taskId} probe 视频时长失败,仅应用淡入: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 写入临时 concat 列表文件(用于 stream-loop 循环音频)
  const loopListFile = join(tmpdir(), `jvf_audioloop_${taskId}.txt`);
  await writeFile(loopListFile, `file '${audioPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`, 'utf8');

  // 使用 fluent-ffmpeg 直接构建命令
  const cmd = ffmpeg();
  // 第一个输入:视频(主)
  cmd.input(videoPath);
  // 第二个输入:音频(若循环则使用 concat 列表 + stream_loop)
  if (opts.audioLoop) {
    cmd.inputOptions(['-stream_loop', '-1', '-f', 'concat', '-safe', '0']);
    cmd.input(loopListFile);
  } else {
    cmd.input(audioPath);
  }

  // 音频滤镜
  if (audioFilters.length > 0) {
    cmd.audioFilters(audioFilters.join(','));
  }

  // 映射:取视频的第 0 个视频流 + 音频的第 0 个音频流
  cmd.outputOptions(['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest']);
  cmd.output(output);

  // 包装为 Promise 执行(与 ffmpegService.runCommand 行为一致)
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
 * 处理单个文件夹:抽音频 + 抽视频 → 合成独立片段
 * 文件夹隔离硬约束:本函数内只对入参 folderId 调用 pickFromFolder
 * @param folderId 文件夹 ID
 * @param params 混剪参数
 * @param workDir 任务工作目录
 * @param index 文件夹序号(用于命名)
 * @param token 取消令牌
 * @returns 独立片段的输出路径
 */
async function processFolder(
  folderId: string,
  params: MixParams,
  workDir: string,
  index: number,
  token: CancelToken,
): Promise<string> {
  assertNotCancelled(token, '');
  const folderDir = join(workDir, `folder_${index}`);
  await mkdir(folderDir, { recursive: true });

  // 1. 刷新素材列表
  await materialRepo.scanFolder(folderId);
  assertNotCancelled(token, '');

  // 2. 单文件夹抽音频 - 隔离 API
  const audioPicks = materialRepo.pickFromFolder(folderId, 1, { kind: 'audio' });
  if (audioPicks.length === 0) {
    throw new Error(
      `[audio-matcher] 文件夹 ${folderId} 无可用音频素材`,
    );
  }
  const audioPath = audioPicks[0].path;

  // 3. 单文件夹抽视频 - 隔离 API
  const videoCount = params.perFolderCount ?? 3;
  const videoPicks: MaterialMeta[] = materialRepo.pickFromFolder(folderId, videoCount, {
    kind: 'video',
    unique: true,
  });
  if (videoPicks.length === 0) {
    throw new Error(
      `[audio-matcher] 文件夹 ${folderId} 无可用视频素材`,
    );
  }

  logger.info(
    `[audio-matcher] 文件夹 ${folderId}: 抽 ${videoPicks.length} 视频 + 1 音频`,
  );

  // 4. 若 stripOriginalAudio:对视频分段 stripAudio
  const videoSegments: string[] = [];
  for (let i = 0; i < videoPicks.length; i++) {
    assertNotCancelled(token, '');
    const mat = videoPicks[i];
    if (params.stripOriginalAudio) {
      const stripped = join(folderDir, `v${i}_noaudio.mp4`);
      await ffmpegService.stripAudio(mat.path, stripped, token);
      videoSegments.push(stripped);
    } else {
      videoSegments.push(mat.path);
    }
  }

  // 5. 拼接视频分段(filter 模式,兼容异源)
  assertNotCancelled(token, '');
  const concatVideo = join(folderDir, 'concat_video.mp4');
  await ffmpegService.concat(videoSegments, concatVideo, { mode: 'filter' }, token);

  // 6. 合成音频+视频
  assertNotCancelled(token, '');
  const merged = join(folderDir, 'merged.mp4');
  await mergeAudioVideo(
    concatVideo,
    audioPath,
    merged,
    {
      audioLoop: params.audioLoop ?? false,
      audioFadeSec: params.audioFadeSec ?? 0,
    },
    token,
  );

  // 7. 应用 scale 统一比例
  assertNotCancelled(token, '');
  const scaleFilter = buildScaleFilter(params.resolution, params.keepOriginalQuality);
  if (scaleFilter.length > 0) {
    const scaled = join(folderDir, 'scaled.mp4');
    await ffmpegService.transcode(
      merged,
      scaled,
      {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
        extraOutputOptions: ['-vf', scaleFilter],
      },
      token,
    );
    return scaled;
  }

  return merged;
}

/**
 * 执行文件夹音频匹配混剪
 * @param params 混剪参数
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns 混剪结果
 */
export async function runAudioMatch(
  params: MixParams,
  taskId: string,
  token: CancelToken,
): Promise<MixResult> {
  // ===== 1. 参数校验 =====
  if (!params.folderIds || params.folderIds.length === 0) {
    throw new Error('[audio-matcher] folderIds 不能为空');
  }

  logger.info(
    `[audio-matcher] 任务 ${taskId} 开始: ${params.folderIds.length} 个文件夹`,
  );

  // ===== 2. 创建工作目录 =====
  const workDir = await ensureWorkDir(taskId);

  // ===== 2.5 断点续渲染:加载 checkpoint 确定跳过哪些已完成步骤 =====
  let skipFolders = false;
  let skipConcat = false;
  let skipWatermark = false;
  let skipSubtitle = false;
  let resumeFile = '';
  /** 续渲染:从哪个文件夹索引开始(folder checkpoint 中途恢复) */
  let resumeFolderIndex = 0;

  const cp = taskQueue.loadCheckpoint(taskId);
  if (cp) {
    const ctx = cp.context as Record<string, unknown>;
    const isExistingFile = (f: unknown): f is string => typeof f === 'string' && f.length > 0 && existsSync(f);

    if (cp.step === 'audio-finalize' && isExistingFile(ctx.finalPath)) {
      logger.info(`[audio-matcher] 任务 ${taskId} checkpoint=finalize,直接返回`);
      const meta = await ffmpegService.probe(ctx.finalPath);
      return { outputPath: ctx.finalPath, durationSec: meta.durationSec, segmentCount: 0 };
    }
    if (cp.step === 'audio-subtitle' && isExistingFile(ctx.currentFile)) {
      skipFolders = skipConcat = skipWatermark = skipSubtitle = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'audio-watermark' && isExistingFile(ctx.currentFile)) {
      skipFolders = skipConcat = skipWatermark = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'audio-concat' && isExistingFile(ctx.currentFile)) {
      skipFolders = skipConcat = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'audio-folder') {
      // 中途恢复:从已处理的文件夹之后继续
      const savedPaths = Array.isArray(ctx.segmentPaths) ? ctx.segmentPaths as string[] : [];
      const savedIdx = typeof ctx.folderIndex === 'number' ? ctx.folderIndex : -1;
      if (savedPaths.length > 0 && savedIdx >= 0) {
        // 校验已保存的片段文件是否都存在
        const allExist = savedPaths.every((p) => existsSync(p));
        if (allExist) {
          resumeFolderIndex = savedIdx + 1;
          logger.info(`[audio-matcher] 任务 ${taskId} 从文件夹 ${resumeFolderIndex} 续渲染`);
        }
      }
    }
    if (resumeFile) {
      logger.info(`[audio-matcher] 任务 ${taskId} 从 checkpoint(step=${cp.step})续渲染`);
    }
  }

  // ===== 3. 每个文件夹独立处理 → 收集独立片段 =====
  // 进度分配:每文件夹处理占 0-60%,拼接 60-75%,水印 75-85%,字幕 85-95%,最终输出 95-100%
  const folderCount = params.folderIds.length;
  const segmentPaths: string[] = [];
  if (!skipFolders) {
  for (let i = resumeFolderIndex; i < folderCount; i++) {
    assertNotCancelled(token, taskId);
    const folderId = params.folderIds[i];
    const segPath = await processFolder(folderId, params, workDir, i, token);
    segmentPaths.push(segPath);

    // 推送进度(保存累积 segmentPaths 以支持中途恢复)
    const progress = 60 * ((i + 1) / folderCount);
    taskQueue.saveCheckpoint(taskId, 'audio-folder', progress, {
      folderIndex: i,
      segmentPath: segPath,
      segmentPaths: [...segmentPaths],
    });
  }
  } // end if (!skipFolders)

  if (segmentPaths.length === 0 && !skipFolders) {
    throw new Error('[audio-matcher] 未生成任何片段');
  }

  // ===== 4. 拼接所有独立片段为最终视频 =====
  assertNotCancelled(token, taskId);
  let currentFile: string;
  if (skipConcat) {
    currentFile = resumeFile;
    logger.info(`[audio-matcher] 任务 ${taskId} 跳过 concat,使用 ${resumeFile}`);
  } else if (segmentPaths.length === 1) {
    // 仅一个文件夹,无需拼接
    currentFile = segmentPaths[0];
    taskQueue.saveCheckpoint(taskId, 'audio-concat', 75, { currentFile });
  } else {
    const concatOutput = join(workDir, 'final_concat.mp4');
    await ffmpegService.concat(segmentPaths, concatOutput, { mode: 'filter' }, token);
    currentFile = concatOutput;
    taskQueue.saveCheckpoint(taskId, 'audio-concat', 75, { currentFile });
  }

  // ===== 5. 应用水印(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.watermark?.enabled && !skipWatermark) {
    const wmOutput = join(workDir, 'watermarked.mp4');
    currentFile = await applyWatermarkIfNeeded(
      currentFile,
      wmOutput,
      params.watermark,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'audio-watermark', 85, { currentFile });
  } else if (skipWatermark && params.watermark?.enabled) {
    logger.info(`[audio-matcher] 任务 ${taskId} 跳过 watermark`);
  }

  // ===== 6. 烧录字幕(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.subtitle?.srtPath && !skipSubtitle) {
    const subOutput = join(workDir, 'subtitle.mp4');
    currentFile = await burnSubtitleIfNeeded(
      currentFile,
      subOutput,
      params.subtitle,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'audio-subtitle', 95, { currentFile });
  } else if (skipSubtitle && params.subtitle?.srtPath) {
    logger.info(`[audio-matcher] 任务 ${taskId} 跳过 subtitle`);
  }

  // ===== 7. 输出到最终路径 =====
  assertNotCancelled(token, taskId);
  const finalName = (params.outputName ?? `audio-mix-${Date.now()}.mp4`).trim();
  const finalPath = resolveExportPath(params.outputDir, finalName);
  await ffmpegService.transcode(
    currentFile,
    finalPath,
    { videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' },
    token,
  );

  // 探测最终时长
  const meta = await ffmpegService.probe(finalPath);

  taskQueue.saveCheckpoint(taskId, 'audio-finalize', 100, { finalPath });
  logger.info(
    `[audio-matcher] 任务 ${taskId} 完成: ${finalPath}, 时长 ${meta.durationSec}s`,
  );

  return {
    outputPath: finalPath,
    durationSec: meta.durationSec,
    segmentCount: segmentPaths.length,
  };
}
