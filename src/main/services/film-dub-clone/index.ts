/**
 * 影视解说克隆服务统一入口
 *
 * 职责:
 *   - 提供 FilmDubCloneService 类,串联节奏提取、素材匹配与节奏复刻
 *   - 暴露 filmDubCloneService 单例供 IPC 层调用
 *
 * 完整流程:
 *   参考视频 → extractRhythm 检测镜头节奏 → matchMaterials 视觉匹配自有素材
 *   → cloneVideo 按参考镜头时长切片/拼接/配音/字幕/水印 → 输出成片
 *
 * 节奏复刻:输出片段数 = 参考镜头数,每段时长 = 对应参考镜头时长,
 *          画面替换为自有素材,文案驱动配音与字幕。
 */
import { CancelToken } from '../ffmpeg/types';
import { extractRhythm } from './rhythm-extractor';
import { matchMaterials } from './material-matcher';
import { cloneVideo } from './cloner';
import { taskQueue } from '../task-queue';
import { logger } from '../../utils/logger';
import type { CloneParams, CloneResult } from './types';

/**
 * 影视解说克隆服务
 * 通过 runClone 方法串联 rhythm-extractor / material-matcher / cloner,完成端到端流程
 */
export class FilmDubCloneService {
  /**
   * 执行影视解说克隆
   *
   * 流程:
   *   1. extractRhythm:检测参考视频镜头节奏 → RhythmPattern
   *   2. matchMaterials:参考镜头中间帧 ↔ 自有素材帧 CLIP 视觉匹配 → ShotMatch[]
   *   3. cloneVideo:按参考镜头时长切片/拼接/配音/字幕/水印 → 成片
   *
   * @param params 克隆参数
   * @param taskId 任务 ID(用于 checkpoint 与日志)
   * @param token 取消令牌
   * @returns 克隆结果
   */
  async runClone(
    params: CloneParams,
    taskId: string,
    token: CancelToken,
  ): Promise<CloneResult> {
    logger.info(
      `[film-dub-clone] 任务 ${taskId} 启动: 参考视频=${params.referenceVideoPath}, ` +
        `folderId=${params.folderId}, 文案 ${params.script.length} 字符`,
    );

    // ===== 1. 节奏提取:参考视频 → 镜头序列 =====
    const rhythm = await extractRhythm(
      params.referenceVideoPath,
      taskQueue,
      taskId,
      token,
    );

    // ===== 2. 素材匹配:参考镜头 ↔ 自有素材帧 =====
    const matches = await matchMaterials(
      rhythm,
      params.folderId,
      params.script,
      taskQueue,
      taskId,
      token,
    );

    // ===== 3. 节奏复刻:matches → 最终成片 =====
    const result = await cloneVideo(matches, rhythm, params, taskQueue, taskId, token);

    logger.info(
      `[film-dub-clone] 任务 ${taskId} 全流程完成: ${result.outputPath} ` +
        `(${result.durationSec}s, ${result.segmentCount} 段)`,
    );
    return result;
  }
}

/** 影视解说克隆服务单例 */
export const filmDubCloneService = new FilmDubCloneService();

// 重新导出类型,便于 IPC 层与渲染层统一引用
export type { CloneParams, CloneResult, RhythmPattern, ShotMatch } from './types';
