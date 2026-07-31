/**
 * AI 切片服务统一入口
 *
 * 职责:
 *   - 提供 AiSliceService 类,串联镜头检测、精彩度分析与切片导出
 *   - 暴露 aiSliceService 单例供 IPC 层调用
 *
 * 完整流程:
 *   长视频 → ffmpegService.probe 获取时长 → shotDetectService.detect 检测镜头
 *   → analyzeShots 评估精彩度 → exportClips 切片导出 → 返回切片列表
 */
import { shotDetectService } from '../shot-detect';
import { ffmpegService } from '../ffmpeg';
import { CancelToken } from '../ffmpeg/types';
import { taskQueue } from '../task-queue';
import { analyzeShots } from './analyzer';
import { exportClips } from './slicer';
import { logger } from '../../utils/logger';
import type { AiSliceParams, AiSliceResult, AnalyzeOptions } from './types';

/** probe 阶段进度(%) */
const PROGRESS_PROBE = 5;
/** 镜头检测阶段进度(%) */
const PROGRESS_DETECT = 15;

/**
 * AI 切片服务
 * 通过 runSlice 方法串联 analyzer 与 slicer,完成"长视频 → 短视频切片"端到端流程
 */
export class AiSliceService {
  /**
   * 执行 AI 切片
   *
   * 流程:
   *   1. probe 获取视频时长
   *   2. shotDetectService.detect 检测镜头边界
   *   3. analyzeShots 评估每个镜头的精彩度并过滤
   *   4. exportClips 把达标镜头切出为独立短视频
   *
   * @param params AI 切片参数
   * @param taskId 任务 ID(用于 checkpoint 与日志)
   * @param token 取消令牌
   * @returns AI 切片结果
   */
  async runSlice(
    params: AiSliceParams,
    taskId: string,
    token: CancelToken,
  ): Promise<AiSliceResult> {
    // 规范化默认值
    const minClipDuration = params.minClipDuration ?? 8;
    const maxClipDuration = params.maxClipDuration ?? 30;
    const excitementThreshold = params.excitementThreshold ?? 0.5;
    const options: AnalyzeOptions = {
      minClipDuration,
      maxClipDuration,
      excitementThreshold,
    };

    // ===== 1. probe 获取总时长 =====
    const meta = await ffmpegService.probe(params.videoPath);
    logger.info(
      `[ai-slice] 任务 ${taskId} 启动: ${params.videoPath}, 总时长 ${meta.durationSec}s`,
    );
    taskQueue.saveCheckpoint(taskId, 'ai-slice-probe', PROGRESS_PROBE, {
      duration: meta.durationSec,
    });

    // ===== 2. 检测镜头 =====
    const detectResult = await shotDetectService.detect(params.videoPath);
    logger.info(
      `[ai-slice] 任务 ${taskId} 镜头检测完成: ${detectResult.shotCount} 个镜头`,
    );
    taskQueue.saveCheckpoint(taskId, 'ai-slice-detect', PROGRESS_DETECT, {
      shotCount: detectResult.shotCount,
    });

    // ===== 3. 评估精彩度 =====
    const analyzed = await analyzeShots(
      params.videoPath,
      detectResult.shots,
      options,
      taskQueue,
      taskId,
      token,
    );

    // ===== 4. 切片导出 =====
    const clips = await exportClips(analyzed, params, taskQueue, taskId, token);

    const result: AiSliceResult = {
      clips,
      totalClips: clips.length,
    };
    logger.info(
      `[ai-slice] 任务 ${taskId} 全流程完成: ${clips.length} 个切片`,
    );
    return result;
  }
}

/** AI 切片服务单例 */
export const aiSliceService = new AiSliceService();

// 重新导出类型,便于 IPC 层与渲染层统一引用
export type { AiSliceParams, AiSliceResult, SliceClip } from './types';
