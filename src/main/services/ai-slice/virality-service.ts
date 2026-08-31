/**
 * 爆款评分编排服务(PRD-爆款评分与智能分发 FR-1/FR-2/FR-3)
 *
 * 职责:
 *   - 串联 ASR 转写(尽力而为)→ LLM 批量评分 → 失败降级启发式基础评分
 *   - 暴露 viralityScorer 单例供 IPC 层调用
 *
 * 降级策略:
 *   - 单条切片 ASR 失败 → 该条转写为空文本,不阻断评分流程;
 *     首条即失败(如打包环境 onnxruntime 缺失)则跳过剩余转写
 *   - LLM 未配置/调用失败/返回全非法 → 全部回退 mapHeuristicToVirality 基础评分
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, rmSync } from 'fs';
import { extractSubtitleAsr } from '../asr';
import { llmService } from '../llm';
import { logger } from '../../utils/logger';
import { mapHeuristicToVirality } from './score';
import { VIRALITY_SYSTEM, buildViralityPrompt } from './virality';
import type { ViralityReport } from './types';

/** 参与评分的单个切片输入(渲染层 → 主进程) */
export interface ViralityScoreClipInput {
  /** 切片索引(从 1 开始,须与切片结果一致) */
  index: number;
  /** 切片文件绝对路径 */
  outputPath: string;
  /** 时长(秒) */
  duration: number;
  /** 启发式精彩度评分(0-1),降级路径使用 */
  excitementScore: number;
}

/** 评分编排结果 */
export interface ViralityScoreResult {
  /** 切片索引 → 评分报告 */
  reports: Record<number, ViralityReport>;
  /** 本次评分整体来源:llm=智能评分 / heuristic=全部降级为基础评分 */
  source: 'llm' | 'heuristic';
}

/**
 * 把 SRT 字幕文本解析为纯文本(剥离序号行与时间轴行)
 * @param srt SRT 文件内容
 * @returns 纯文本(单行,句间以空格连接)
 */
export function parseSrtToText(srt: string): string {
  return srt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/-->\s/.test(line))
    .join(' ');
}

/**
 * 爆款评分编排器
 */
export class ViralityScorer {
  /**
   * 对切片列表执行爆款评分
   * 流程:逐条 ASR 转写(尽力而为)→ 单次 LLM 批量评分 → 逐条合并,
   *      LLM 未覆盖的条目回退启发式基础评分
   * @param clips 切片输入列表
   * @returns 评分结果(索引 → 报告)
   */
  async score(clips: ViralityScoreClipInput[]): Promise<ViralityScoreResult> {
    // ===== 1. ASR 转写(尽力而为,失败不阻断) =====
    const transcripts = new Map<number, string>();
    let asrDisabled = false;
    for (const clip of clips) {
      if (asrDisabled) {
        transcripts.set(clip.index, '');
        continue;
      }
      const text = await this.transcribeBestEffort(clip);
      transcripts.set(clip.index, text);
      // 首条即失败(典型:引擎不可用)时跳过剩余转写,避免逐条空耗
      if (text.length === 0 && clip === clips[0] && clips.length > 1) {
        asrDisabled = true;
        logger.warn('[virality] 首条切片 ASR 失败,跳过剩余切片转写');
      }
    }

    // ===== 2. LLM 批量评分(单次调用,失败整体降级) =====
    try {
      const messages = [
        { role: 'system', content: VIRALITY_SYSTEM },
        {
          role: 'user',
          content: buildViralityPrompt(
            clips.map((c) => ({
              index: c.index,
              durationSec: c.duration,
              transcript: transcripts.get(c.index) ?? '',
            })),
          ),
        },
      ];
      const resp = await llmService.chat({ messages, temperature: 0.3, maxTokens: 4096 });
      const parsed = parseViralityReports(resp.content);
      const reports: Record<number, ViralityReport> = {};
      let llmCount = 0;
      for (const clip of clips) {
        const fromLlm = parsed[clip.index];
        if (fromLlm) {
          reports[clip.index] = fromLlm;
          llmCount++;
        } else {
          // LLM 未覆盖的条目回退基础评分(FR-3 失败隔离)
          reports[clip.index] = mapHeuristicToVirality(clip.excitementScore);
        }
      }
      logger.info(`[virality] LLM 评分完成: ${llmCount}/${clips.length} 条智能评分`);
      return { reports, source: 'llm' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[virality] LLM 评分失败,整体降级为基础评分: ${msg}`);
      // ===== 3. 整体降级:全部走启发式基础评分 =====
      const reports: Record<number, ViralityReport> = {};
      for (const clip of clips) {
        reports[clip.index] = mapHeuristicToVirality(clip.excitementScore);
      }
      return { reports, source: 'heuristic' };
    }
  }

  /**
   * 单条切片 ASR 转写(尽力而为):转写 → SRT → 纯文本,失败返回空串
   * @param clip 切片输入
   * @returns 转写纯文本;失败为空字符串
   */
  private async transcribeBestEffort(clip: ViralityScoreClipInput): Promise<string> {
    const srtPath = join(
      tmpdir(),
      `virality-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.srt`,
    );
    try {
      await extractSubtitleAsr({
        params: { videoPath: clip.outputPath, outputPath: srtPath, modelSize: 'base' },
      });
      const srt = readFileSync(srtPath, 'utf8');
      return parseSrtToText(srt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[virality] 切片 ${clip.index} ASR 转写失败,以空文本参与评分: ${msg}`);
      return '';
    } finally {
      try {
        rmSync(srtPath, { force: true });
      } catch {
        /* 清理失败可忽略 */
      }
    }
  }
}

/** 爆款评分编排器单例 */
export const viralityScorer = new ViralityScorer();
