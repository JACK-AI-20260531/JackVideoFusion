/**
 * AI 剪辑服务统一入口
 *
 * 职责:
 *   - 提供 AiEditService 类,串联语义匹配(matchScenesToScript)与成片合成(composeVideo)
 *   - 暴露 aiEditService 单例供 IPC 层调用
 *
 * 完整流程:
 *   文案 + folderId → LLM 抽关键词 → CLIP 文本/画面向量匹配 → 按段落选最佳帧
 *   → FFmpeg 切片/拼接 → 可选 TTS 配音 → 可选字幕烧录 → 可选水印 → 输出成片
 */
import { CancelToken } from '../ffmpeg/types';
import { matchScenesToScript } from './matcher';
import { composeVideo } from './composer';
import { logger } from '../../utils/logger';
import type { AiEditParams, AiEditResult } from './types';

/**
 * AI 剪辑服务
 * 通过 runEdit 方法串联 matcher 与 composer,完成"文案 → 成片"端到端流程
 */
export class AiEditService {
  /**
   * 执行 AI 剪辑
   *
   * 流程:
   *   1. matchScenesToScript:LLM 抽关键词 + CLIP 语义匹配 → SceneMatch[]
   *   2. composeVideo:按 matches 切片/拼接/配音/字幕/水印 → 成片
   *
   * @param params AI 剪辑参数
   * @param taskId 任务 ID(用于 checkpoint 与日志)
   * @param token 取消令牌
   * @returns AI 剪辑结果
   */
  async runEdit(
    params: AiEditParams,
    taskId: string,
    token: CancelToken,
  ): Promise<AiEditResult> {
    logger.info(
      `[ai-edit] 任务 ${taskId} 启动: folderId=${params.folderId}, 文案 ${params.script.length} 字符`,
    );

    // ===== 1. 语义匹配:文案 → 场景帧 =====
    const { matches, keywords } = await matchScenesToScript(
      params.script,
      params.folderId,
      taskId,
      token,
    );

    // ===== 2. 成片合成:场景帧 → 最终视频 =====
    const result = await composeVideo(matches, keywords, params, taskId, token);
    // 兜底标注(PRD v1.6 FR-4):统计使用兜底画面的段落数
    const fallbackCount = matches.filter((m) => m.fallback).length;
    if (fallbackCount > 0) {
      result.fallbackCount = fallbackCount;
      logger.info(`[ai-edit] 任务 ${taskId} 有 ${fallbackCount} 段使用兜底画面`);
    }

    logger.info(
      `[ai-edit] 任务 ${taskId} 全流程完成: ${result.outputPath} (${result.durationSec}s, ${result.segmentCount} 段)`,
    );
    return result;
  }
}

/** AI 剪辑服务单例 */
export const aiEditService = new AiEditService();

// 重新导出类型,便于 IPC 层与渲染层统一引用
export type { AiEditParams, AiEditResult, SceneMatch, KeywordPreview } from './types';
