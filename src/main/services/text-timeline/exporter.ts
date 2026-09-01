/**
 * EDL 导出器(PRD-文本即时间线 v2.0 M3 / FR-3)
 *
 * 职责:把 EDL(有序保留片段)渲染为成片
 *   1. 逐片段 ffmpeg 精确裁剪(重编码,静音段丢弃音频)
 *   2. concat demuxer 无损拼接
 *   3. 输出时长一致性校验(实际时长 vs EDL 期望,容差默认 0.5s)
 *
 * 设计要点:
 *   - 分段重编码保证剪辑点精确;拼接用 concat demuxer 零损耗
 *   - 中间产物放输出目录临时子目录,完成后清理
 *   - ffmpeg I/O 全部依赖注入,纯逻辑可单测
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger';
import { ffmpegService } from '../ffmpeg';

/** 一致性校验默认容差(秒) */
export const EXPORT_TOLERANCE_SEC = 0.5;

/** 外部依赖(可注入以便单测) */
export interface TextTimelineExportDeps {
  /** 精确区间裁剪(默认 ffmpegService.trim) */
  trim?: (
    input: string,
    output: string,
    opts: { startSec: number; endSec: number; muteAudio?: boolean },
  ) => Promise<string>;
  /** 无损拼接(默认 ffmpegService.concat) */
  concat?: (inputs: string[], output: string) => Promise<string>;
  /** 时长探测(默认 ffmpegService.getDuration) */
  getDuration?: (path: string) => Promise<number>;
  /** 时间戳(测试注入) */
  now?: () => number;
}

/** 导出结果 */
export interface EdlExportResult {
  /** 输出文件路径 */
  outputPath: string;
  /** EDL 期望时长(秒) */
  expectedSec: number;
  /** 实际输出时长(秒) */
  actualSec: number;
  /** 一致性校验是否通过 */
  consistent: boolean;
  /** 保留片段数 */
  clipCount: number;
  /** 静音片段数 */
  mutedClipCount: number;
}

/**
 * 导出一致性校验(纯函数)
 * @param expectedSec EDL 期望时长(秒)
 * @param actualSec 实际输出时长(秒)
 * @param toleranceSec 容差(默认 0.5s)
 * @returns 是否一致
 */
export function validateExportConsistency(
  expectedSec: number,
  actualSec: number,
  toleranceSec = EXPORT_TOLERANCE_SEC,
): boolean {
  if (!Number.isFinite(expectedSec) || !Number.isFinite(actualSec)) return false;
  return Math.abs(actualSec - expectedSec) <= toleranceSec;
}

/** 文本即时间线导出器 */
export class TextTimelineExporter {
  constructor(private deps: TextTimelineExportDeps = {}) {}

  /**
   * 渲染 EDL 为成片
   * @param params.videoPath 源素材路径
   * @param params.edl EDL(有序保留片段)
   * @param params.outputDir 输出目录
   * @param params.outputName 输出文件名(缺省自动命名)
   * @returns 导出结果(含一致性校验)
   */
  async exportEdl(params: {
    videoPath: string;
    edl: import('./types').EDL;
    outputDir: string;
    outputName?: string;
  }): Promise<EdlExportResult> {
    const { videoPath, edl, outputDir } = params;
    const clips = edl.clips;
    if (clips.length === 0) {
      throw new Error('EDL 无保留片段,无法导出');
    }
    if (!outputDir || typeof outputDir !== 'string') {
      throw new Error('缺少输出目录');
    }
    const now = this.deps.now ?? Date.now;
    const trim = this.deps.trim ?? ((i: string, o: string, opt: { startSec: number; endSec: number; muteAudio?: boolean }) => ffmpegService.trim(i, o, opt));
    const concat = this.deps.concat ?? ((inputs: string[], output: string) => ffmpegService.concat(inputs, output));
    const getDuration = this.deps.getDuration ?? ((p: string) => ffmpegService.getDuration(p));

    const outputName = params.outputName?.trim() || `text-timeline-${now()}.mp4`;
    const outputPath = join(outputDir, outputName);
    const workDir = join(outputDir, `.tt-export-${now()}`);
    mkdirSync(workDir, { recursive: true });

    try {
      // ===== 1. 逐片段精确裁剪(静音段丢音频) =====
      const segmentFiles: string[] = [];
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const segPath = join(workDir, `seg-${String(i + 1).padStart(3, '0')}.mp4`);
        await trim(videoPath, segPath, {
          startSec: clip.srcStart,
          endSec: clip.srcEnd,
          muteAudio: !!clip.muted,
        });
        segmentFiles.push(segPath);
      }

      // ===== 2. 无损拼接 =====
      await concat(segmentFiles, outputPath);

      // ===== 3. 一致性校验 =====
      const expectedSec = clips.reduce((sum, c) => sum + (c.srcEnd - c.srcStart), 0);
      let actualSec = NaN;
      try {
        actualSec = await getDuration(outputPath);
      } catch (err) {
        logger.warn(`[TextTimeline] 输出时长探测失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      const consistent = validateExportConsistency(expectedSec, actualSec);
      if (!consistent) {
        logger.warn(`[TextTimeline] 导出一致性校验未通过: expected=${expectedSec.toFixed(2)} actual=${actualSec}`);
      }
      const mutedClipCount = clips.filter((c) => c.muted).length;
      logger.info(
        `[TextTimeline] EDL 导出完成: ${outputPath} clips=${clips.length} muted=${mutedClipCount} consistent=${consistent}`,
      );
      return {
        outputPath,
        expectedSec,
        actualSec,
        consistent,
        clipCount: clips.length,
        mutedClipCount,
      };
    } finally {
      // 清理中间产物
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* 忽略清理错误 */
      }
    }
  }
}
