/**
 * 随机素材混剪(模式一)实现
 *
 * 职责:从多个文件夹各抽取若干视频片段 → 可选切短分段 → 拼接 → 应用水印/字幕
 *
 * 执行流程:
 *   1. 校验 folderIds 非空、perFolderCount>0
 *   2. 对每个 folderId:scanFolder → pickFromFolder(单文件夹抽取,隔离)
 *   3. 对每个抽取的视频:若 segmentSec>0,用 ffmpegService.split 切短分段
 *   4. 用 ffmpegService.concat 拼接所有分段(filter 模式重编码以兼容异源)
 *   5. 应用 scale 滤镜统一比例(通过 transcode 阶段或 concat filter 后处理)
 *   6. 若 watermark.enabled:applyWatermark(用 toFfmpegPosition 转换位置)
 *   7. 若 subtitle.srtPath:burnSubtitle
 *   8. 每个原子步骤后保存 checkpoint 并推送进度
 *   9. 每步检查 token.cancelled,取消时抛 FFmpegError(CANCELLED)
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdir } from 'fs/promises';
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
 * 创建任务专用工作目录:userData/video-mix-work/<taskId>/
 * 用于存放中间分段与中间拼接文件
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
 * @param taskId 任务 ID(用于错误信息)
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
 * 执行随机素材混剪
 * @param params 混剪参数
 * @param taskId 任务 ID(用于进度推送与 checkpoint)
 * @param token 取消令牌
 * @returns 混剪结果(输出路径、时长、片段数)
 */
export async function runRandomMix(
  params: MixParams,
  taskId: string,
  token: CancelToken,
): Promise<MixResult> {
  // ===== 1. 参数校验 =====
  if (!params.folderIds || params.folderIds.length === 0) {
    throw new Error('[random-mixer] folderIds 不能为空');
  }
  const perFolderCount = params.perFolderCount ?? 0;
  if (perFolderCount <= 0) {
    throw new Error('[random-mixer] perFolderCount 必须 > 0');
  }

  logger.info(
    `[random-mixer] 任务 ${taskId} 开始: ${params.folderIds.length} 个文件夹, 每文件夹 ${perFolderCount} 条`,
  );

  // 进度分配:抽取 10% → 切分 20% → 拼接 40% → 水印 15% → 字幕 15%
  // 各阶段内部按需细分;每完成一步保存 checkpoint

  // ===== 2. 创建工作目录 =====
  const workDir = await ensureWorkDir(taskId);
  assertNotCancelled(token, taskId);

  // ===== 3. 抽取素材(每个文件夹单点抽取,严格隔离) =====
  const allSegments: string[] = [];
  const folderCount = params.folderIds.length;
  for (let i = 0; i < folderCount; i++) {
    const folderId = params.folderIds[i];
    assertNotCancelled(token, taskId);

    // 先 scanFolder 刷新素材列表
    await materialRepo.scanFolder(folderId);
    // 单文件夹抽取 - 隔离 API
    const picked: MaterialMeta[] = materialRepo.pickFromFolder(folderId, perFolderCount, {
      kind: 'video',
      unique: params.uniqueReuse ?? false,
    });
    logger.info(
      `[random-mixer] 文件夹 ${folderId} 抽取 ${picked.length} 条视频`,
    );

    // 对每个抽取的视频:若 segmentSec>0 则切短分段
    const segmentSec = params.segmentSec ?? 0;
    for (let j = 0; j < picked.length; j++) {
      assertNotCancelled(token, taskId);
      const mat = picked[j];
      if (segmentSec > 0) {
        // 切短分段:输出到 workDir/<folderId>_<j>/
        const segDir = join(workDir, `f${i}_v${j}`);
        await mkdir(segDir, { recursive: true });
        const segs = await ffmpegService.split(
          mat.path,
          segmentSec,
          segDir,
          { prefix: `seg_${i}_${j}_`, ext: 'mp4' },
          token,
        );
        // 若设置了 targetDurationSec>0,只取首段以满足总时长约束(简化版:取所有分段)
        allSegments.push(...segs);
      } else {
        // 不切分,直接用原视频
        allSegments.push(mat.path);
      }
    }

    // 推送进度(抽取阶段 0-10%)
    const progress = 10 * ((i + 1) / folderCount);
    taskQueue.saveCheckpoint(taskId, 'random-pick', progress, {
      folderIndex: i,
      segments: allSegments.length,
    });
  }

  if (allSegments.length === 0) {
    throw new Error('[random-mixer] 未抽取出任何视频片段,请检查文件夹素材');
  }

  logger.info(`[random-mixer] 共收集 ${allSegments.length} 个分段,开始拼接`);

  // ===== 4. 拼接所有分段(filter 模式,兼容异源) =====
  assertNotCancelled(token, taskId);
  const concatOutput = join(workDir, 'concat.mp4');
  await ffmpegService.concat(allSegments, concatOutput, { mode: 'filter' }, token);
  taskQueue.saveCheckpoint(taskId, 'random-concat', 40, { concatOutput });

  // ===== 5. 应用 scale 滤镜统一比例(若不保留原画质) =====
  assertNotCancelled(token, taskId);
  let currentFile = concatOutput;
  const scaleFilter = buildScaleFilter(params.resolution, params.keepOriginalQuality);
  if (scaleFilter.length > 0) {
    // 通过 transcode 应用 scale 滤镜;使用 medium 预设平衡速度/质量
    const scaledOutput = join(workDir, 'scaled.mp4');
    await ffmpegService.transcode(
      currentFile,
      scaledOutput,
      {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
        extraOutputOptions: ['-vf', scaleFilter],
      },
      token,
    );
    currentFile = scaledOutput;
    taskQueue.saveCheckpoint(taskId, 'random-scale', 55, { currentFile });
  }

  // ===== 6. 应用水印(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.watermark?.enabled) {
    const wmOutput = join(workDir, 'watermarked.mp4');
    currentFile = await applyWatermarkIfNeeded(
      currentFile,
      wmOutput,
      params.watermark,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'random-watermark', 70, { currentFile });
  }

  // ===== 7. 烧录字幕(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.subtitle?.srtPath) {
    const subOutput = join(workDir, 'subtitle.mp4');
    currentFile = await burnSubtitleIfNeeded(
      currentFile,
      subOutput,
      params.subtitle,
      token,
    );
    taskQueue.saveCheckpoint(taskId, 'random-subtitle', 85, { currentFile });
  }

  // ===== 8. 输出到最终路径 =====
  assertNotCancelled(token, taskId);
  const finalName = (params.outputName ?? `mix-${Date.now()}.mp4`).trim();
  const finalPath = resolveExportPath(params.outputDir, finalName);
  // 通过 transcode 重封装到最终路径(避免文件跨卷移动问题)
  await ffmpegService.transcode(
    currentFile,
    finalPath,
    { videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' },
    token,
  );

  // 探测最终时长
  const meta = await ffmpegService.probe(finalPath);

  taskQueue.saveCheckpoint(taskId, 'random-finalize', 100, { finalPath });
  logger.info(
    `[random-mixer] 任务 ${taskId} 完成: ${finalPath}, 时长 ${meta.durationSec}s`,
  );

  return {
    outputPath: finalPath,
    durationSec: meta.durationSec,
    segmentCount: allSegments.length,
  };
}
