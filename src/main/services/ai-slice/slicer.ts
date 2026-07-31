/**
 * 切片导出引擎
 *
 * 职责:把评分达标的镜头切出为独立的短视频文件
 *
 * 执行流程:
 *   1. 若 maxClipCount > 0,只取前 N 个(analyzed 已按 score 降序)
 *   2. 对每个镜头:用 ffmpegService.transcode(-ss/-t)精确切出片段
 *   3. 应用 scale 滤镜统一比例(若不保留原画质)
 *   4. 若启用水印:先切到临时文件,再 applyWatermark 到最终路径
 *   5. 输出到 resolveExportPath(outputDir, `${prefix}_${index}.mp4`)
 *
 * 复用约定:
 *   - 切片/水印/转码:全部走 ffmpegService
 *   - 路径解析:resolveExportPath
 *   - scale 滤镜:buildScaleFilter
 *   - 水印位置:toFfmpegPosition
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { ffmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { TaskQueue } from '../task-queue';
import { buildScaleFilter, resolveExportPath, toFfmpegPosition } from '../common';
import { logger } from '../../utils/logger';
import type { AiSliceParams, AnalyzedShot, SliceClip } from './types';

/** 导出阶段起始进度(%) */
const PROGRESS_START = 35;
/** 导出阶段进度跨度(%) */
const PROGRESS_RANGE = 65;

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('AI 切片任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 创建任务专用工作目录:userData/ai-slice-work/<taskId>/
 * @param taskId 任务 ID
 * @returns 工作目录绝对路径
 */
async function ensureWorkDir(taskId: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'ai-slice-work', taskId);
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
  watermark: NonNullable<AiSliceParams['watermark']>,
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
 * 执行切片导出
 *
 * @param analyzed 达标镜头评分列表(已按 score 降序)
 * @param params AI 切片参数
 * @param taskQueue 任务队列(用于进度推送)
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns 切片结果列表
 */
export async function exportClips(
  analyzed: AnalyzedShot[],
  params: AiSliceParams,
  taskQueue: TaskQueue,
  taskId: string,
  token: CancelToken,
): Promise<SliceClip[]> {
  logger.info(
    `[ai-slice/slicer] 任务 ${taskId} 开始导出: ${analyzed.length} 个候选片段`,
  );

  if (analyzed.length === 0) {
    return [];
  }

  // 若 maxClipCount > 0,只取前 N 个(analyzed 已按 score 降序)
  const maxCount = params.maxClipCount ?? 0;
  const selected = maxCount > 0 ? analyzed.slice(0, maxCount) : analyzed;

  const workDir = await ensureWorkDir(taskId);
  const scaleFilter = buildScaleFilter(params.resolution, params.keepOriginalQuality);
  const prefix = (params.outputPrefix ?? 'clip').trim() || 'clip';
  const watermark = params.watermark?.enabled ? params.watermark : null;

  const clips: SliceClip[] = [];
  for (let i = 0; i < selected.length; i++) {
    assertNotCancelled(token, taskId);
    const { shot, score } = selected[i];
    const index = i + 1;
    const startTime = shot.startTime;
    const duration = shot.duration;
    const finalName = `${prefix}_${index}.mp4`;
    const finalPath = resolveExportPath(params.outputDir, finalName);

    // 构造切片 + scale 的输出选项(-ss/-t 精确切片,-vf 统一比例)
    const extraOpts: string[] = ['-ss', String(startTime), '-t', String(duration)];
    if (scaleFilter.length > 0) {
      extraOpts.push('-vf', scaleFilter);
    }

    if (watermark) {
      // 有水印:先切到临时文件,再应用水印到最终路径
      const tmpClip = join(workDir, `clip_${index}.mp4`);
      await ffmpegService.transcode(
        params.videoPath,
        tmpClip,
        {
          videoCodec: 'libx264',
          audioCodec: 'aac',
          preset: 'medium',
          extraOutputOptions: extraOpts,
        },
        token,
      );
      await applyWatermarkIfNeeded(tmpClip, finalPath, watermark, token);
    } else {
      // 无水印:直接切到最终路径
      await ffmpegService.transcode(
        params.videoPath,
        finalPath,
        {
          videoCodec: 'libx264',
          audioCodec: 'aac',
          preset: 'medium',
          extraOutputOptions: extraOpts,
        },
        token,
      );
    }

    clips.push({
      index,
      outputPath: finalPath,
      startTime,
      endTime: shot.endTime,
      duration,
      excitementScore: score,
    });

    // 进度:35-100%,共 65%
    const progress = PROGRESS_START + PROGRESS_RANGE * ((i + 1) / selected.length);
    taskQueue.saveCheckpoint(taskId, 'ai-slice-export', progress, {
      exported: i + 1,
      total: selected.length,
    });
  }

  logger.info(
    `[ai-slice/slicer] 任务 ${taskId} 导出完成: ${clips.length} 个切片`,
  );
  return clips;
}
