/**
 * 节奏提取引擎
 *
 * 职责:解析参考视频的镜头节奏,产出 RhythmPattern 供 matcher 与 cloner 使用
 *
 * 执行流程:
 *   1. 调用 shotDetectService.detect 检测参考视频镜头边界
 *   2. 计算平均镜头时长、总时长、剪辑点数(镜头数 - 1)
 *   3. saveCheckpoint 记录进度
 *   4. 返回 RhythmPattern(携带 referenceVideoPath 供 matcher 抽帧)
 *
 * 复用约定:
 *   - 镜头检测:shotDetectService(内部基于 ffprobe scene 滤镜,失败降级均匀分段)
 *   - 不直接 spawn ffprobe
 */
import { shotDetectService } from '../shot-detect';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { TaskQueue } from '../task-queue';
import { logger } from '../../utils/logger';
import type { RhythmPattern } from './types';

/** 节奏提取阶段进度(%) */
const PROGRESS_RHYTHM = 10;

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
 * 提取参考视频的镜头节奏
 *
 * 步骤:
 *   1. shotDetectService.detect 检测镜头边界
 *   2. 由镜头序列计算平均时长、总时长、剪辑点数
 *   3. 落 checkpoint 并返回 RhythmPattern
 *
 * @param referenceVideoPath 参考视频路径
 * @param taskQueue 任务队列单例(用于 checkpoint;preview 时可为预览态)
 * @param taskId 任务 ID(用于 checkpoint 与日志)
 * @param token 取消令牌
 * @returns 节奏特征
 */
export async function extractRhythm(
  referenceVideoPath: string,
  taskQueue: TaskQueue,
  taskId: string,
  token: CancelToken,
): Promise<RhythmPattern> {
  assertNotCancelled(token, taskId);

  if (!referenceVideoPath || referenceVideoPath.trim().length === 0) {
    throw new Error('[film-dub-clone/rhythm] 参考视频路径为空');
  }

  logger.info(
    `[film-dub-clone/rhythm] 任务 ${taskId} 开始提取节奏: ${referenceVideoPath}`,
  );

  // ===== 1. 检测镜头边界 =====
  const detectResult = await shotDetectService.detect(referenceVideoPath);
  const shots = detectResult.shots;
  if (shots.length === 0) {
    throw new Error(
      `[film-dub-clone/rhythm] 参考视频未检测到任何镜头: ${referenceVideoPath}`,
    );
  }

  // ===== 2. 计算节奏统计量 =====
  const totalDuration = detectResult.totalDuration > 0 ? detectResult.totalDuration : 0;
  const sumDuration = shots.reduce((sum, s) => sum + s.duration, 0);
  const avgShotDuration = shots.length > 0 ? sumDuration / shots.length : 0;
  // 剪辑点数 = 镜头数 - 1(N 个镜头之间有 N-1 个切换点)
  const cutCount = Math.max(0, shots.length - 1);

  logger.info(
    `[film-dub-clone/rhythm] 任务 ${taskId} 节奏提取完成: ${shots.length} 个镜头, ` +
      `平均 ${avgShotDuration.toFixed(2)}s, 总时长 ${totalDuration.toFixed(2)}s, ` +
      `${cutCount} 个剪辑点`,
  );

  // ===== 3. 落 checkpoint =====
  taskQueue.saveCheckpoint(taskId, 'film-dub-rhythm', PROGRESS_RHYTHM, {
    shotCount: shots.length,
    avgShotDuration,
    totalDuration,
    cutCount,
  });

  return {
    referenceVideoPath,
    shots,
    avgShotDuration,
    totalDuration,
    cutCount,
  };
}
