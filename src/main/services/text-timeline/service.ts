/**
 * 文本即时间线会话编排(PRD-文本即时间线 v2.0 M2)
 *
 * 职责:
 *   - prepare:选择视频 → ffprobe 时长 → ASR 句级转写 → 初始 EDL,创建会话
 *   - applyOps/undo/redo:EDL 变更走命令栈,会话状态内存持有
 *   - 每次变更返回带 deleted 标记的段落快照,渲染层直接划线灰显
 *
 * 设计要点:
 *   - electron I/O(ffprobe/ASR 引擎/模型目录)依赖注入,可 mock 单测
 *   - 会话容量上限淘汰最旧,防内存膨胀
 *   - 段落删除判定:与保留片段有效重叠 ≤ 50% 即视为已删除
 */
import { execFile } from 'child_process';
import { logger } from '../../utils/logger';
import { detectFfmpegBinaries } from '../ffmpeg/binary';
import { ensureAsrModelDir } from '../asr/model-dir';
import { WhisperAsrEngine, type AsrEngine } from '../asr/engine';
import type { AsrModelSize, AsrSegment } from '../asr/types';
import type { EDL, EditOp, TextSegment } from './types';
import { CommandStack } from './command-stack';
import { applyOps as applyEdlOps, createEdl, totalDuration } from './edl';
import {
  planFillerCuts,
  planPauseCompression,
  PAUSE_KEEP_SEC,
  PAUSE_THRESHOLD_SEC,
  DEFAULT_FILLER_WORDS,
} from './transcript';

/** 默认 ASR 模型规格 */
const DEFAULT_ASR_MODEL: AsrModelSize = 'base';

/** 会话容量上限(超出淘汰最旧) */
const MAX_SESSIONS = 20;

/** 时长探测失败时,在 ASR 最大结束时间上追加的尾部余量(秒) */
const DURATION_TAIL_SEC = 0.5;

/** 外部依赖(可注入以便单测) */
export interface TextTimelineDeps {
  /** ASR 引擎工厂(默认 WhisperAsrEngine) */
  createAsrEngine?: (modelSize: AsrModelSize, cacheDir: string) => AsrEngine;
  /** 视频时长探测(默认 ffprobe) */
  probeDurationSec?: (videoPath: string) => Promise<number>;
  /** ASR 模型目录(默认 ensureAsrModelDir) */
  ensureModelDir?: () => string;
  /** 会话 ID 生成器(默认随机) */
  genSessionId?: () => string;
}

/** 会话快照(对外返回结构) */
export interface TtSessionSnapshot {
  sessionId: string;
  videoPath: string;
  durationSec: number;
  segments: (TextSegment & { deleted: boolean })[];
  edl: EDL;
  /** 保留总时长(秒,即导出成片时长) */
  totalSec: number;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * ASR 识别片段 → 句级段落(纯函数)
 * 过滤空文本、按时间升序、分配 seg-N 标识
 * @param segments ASR 识别片段
 * @returns 句级段落
 */
export function asrToTextSegments(segments: AsrSegment[]): TextSegment[] {
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.startSec) &&
        Number.isFinite(s.endSec) &&
        typeof s.text === 'string' &&
        s.text.trim().length > 0,
    )
    .sort((a, b) => a.startSec - b.startSec);
  return sorted.map((s, i) => ({
    id: `seg-${i + 1}`,
    text: s.text.trim(),
    start: s.startSec,
    end: Math.max(s.endSec, s.startSec),
  }));
}

/**
 * 段落删除判定(纯函数):与保留片段的有效重叠占比 ≤ 50% 视为已删除
 */
export function isSegmentDeleted(edl: EDL, seg: Pick<TextSegment, 'start' | 'end'>): boolean {
  const len = seg.end - seg.start;
  if (!(len > 0)) return false;
  let overlap = 0;
  for (const clip of edl.clips) {
    const s = Math.max(clip.srcStart, seg.start);
    const e = Math.min(clip.srcEnd, seg.end);
    if (e > s) overlap += e - s;
  }
  return overlap / len <= 0.5;
}

/**
 * 给段落列表打删除标记(纯函数)
 * @param edl 当前 EDL
 * @param segments 句级段落
 * @returns 带 deleted 标记的段落
 */
export function markDeletedSegments<T extends TextSegment>(
  edl: EDL,
  segments: T[],
): (T & { deleted: boolean })[] {
  return segments.map((seg) => ({ ...seg, deleted: isSegmentDeleted(edl, seg) }));
}

/** ffprobe 时长探测(默认实现,可通过 deps 注入替换) */
export async function probeVideoDurationSec(videoPath: string): Promise<number> {
  const binaries = await detectFfmpegBinaries();
  if (!binaries.ffprobePath) throw new Error('未找到 ffprobe,无法探测视频时长');
  return new Promise((resolve, reject) => {
    execFile(
      binaries.ffprobePath as string,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const value = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(value) || value <= 0) {
          reject(new Error('ffprobe 返回时长无效'));
          return;
        }
        resolve(value);
      },
    );
  });
}

/** 会话内部状态 */
interface Session {
  videoPath: string;
  durationSec: number;
  segments: TextSegment[];
  stack: CommandStack<EDL>;
}

/** 文本即时间线服务 */
export class TextTimelineService {
  private sessions = new Map<string, Session>();

  constructor(private deps: TextTimelineDeps = {}) {}

  /**
   * 创建会话:探测时长 → ASR 句级转写 → 初始 EDL
   * @param videoPath 视频绝对路径
   * @returns 会话快照
   */
  async prepare(videoPath: string): Promise<TtSessionSnapshot> {
    if (!videoPath || typeof videoPath !== 'string' || videoPath.trim().length === 0) {
      throw new Error('缺少视频文件路径');
    }

    // ===== 1. 时长探测(失败回退 ASR 最大结束时间) =====
    let durationSec = NaN;
    try {
      durationSec = await (this.deps.probeDurationSec ?? probeVideoDurationSec)(videoPath);
    } catch (err) {
      logger.warn(`[TextTimeline] 时长探测失败,回退 ASR 最大结束时间: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ===== 2. ASR 句级转写 =====
    const createEngine =
      this.deps.createAsrEngine ?? ((size, cacheDir) => new WhisperAsrEngine(size, cacheDir));
    const ensureModelDir = this.deps.ensureModelDir ?? ensureAsrModelDir;
    const engine = createEngine(DEFAULT_ASR_MODEL, ensureModelDir());
    await engine.ensureReady();
    const asrSegments = await engine.transcribe(videoPath);
    if (asrSegments.length === 0) {
      throw new Error('未识别到语音内容,无法建立文本时间线');
    }
    const segments = asrToTextSegments(asrSegments);

    // ===== 3. 会话登记 =====
    if (!Number.isFinite(durationSec)) {
      durationSec = Math.max(...segments.map((s) => s.end)) + DURATION_TAIL_SEC;
    }
    const sessionId = this.deps.genSessionId
      ? this.deps.genSessionId()
      : `tt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: Session = {
      videoPath,
      durationSec,
      segments,
      stack: new CommandStack<EDL>(createEdl(videoPath, durationSec)),
    };
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(sessionId, session);
    logger.info(`[TextTimeline] 会话创建: ${sessionId} segs=${segments.length} dur=${durationSec.toFixed(2)}s`);
    return this.snapshot(sessionId, session);
  }

  /** 应用编辑操作(入撤销栈) */
  applyOps(sessionId: string, ops: EditOp[]): TtSessionSnapshot {
    const session = this.requireSession(sessionId);
    session.stack.apply(applyEdlOps(session.stack.get(), ops));
    return this.snapshot(sessionId, session);
  }

  /** 撤销 */
  undo(sessionId: string): TtSessionSnapshot {
    const session = this.requireSession(sessionId);
    session.stack.undo();
    return this.snapshot(sessionId, session);
  }

  /** 重做 */
  redo(sessionId: string): TtSessionSnapshot {
    const session = this.requireSession(sessionId);
    session.stack.redo();
    return this.snapshot(sessionId, session);
  }

  /**
   * 一键清理口头禅:生成 cut 计划并应用
   * @param sessionId 会话 ID
   * @param fillers 口头禅词表(默认 嗯/啊/然后/就是/那个)
   * @returns 快照 + 实际生成的操作数
   */
  cleanupFillers(
    sessionId: string,
    fillers: string[] = DEFAULT_FILLER_WORDS,
  ): { snapshot: TtSessionSnapshot; planned: number } {
    const session = this.requireSession(sessionId);
    const ops = planFillerCuts(session.segments, fillers);
    if (ops.length > 0) {
      session.stack.apply(applyEdlOps(session.stack.get(), ops));
    }
    return { snapshot: this.snapshot(sessionId, session), planned: ops.length };
  }

  /**
   * 压缩停顿:段间静音 > thresholdSec 压到 keepSec
   * @returns 快照 + 实际生成的操作数
   */
  compressPauses(
    sessionId: string,
    thresholdSec: number = PAUSE_THRESHOLD_SEC,
    keepSec: number = PAUSE_KEEP_SEC,
  ): { snapshot: TtSessionSnapshot; planned: number } {
    const session = this.requireSession(sessionId);
    const ops = planPauseCompression(session.segments, thresholdSec, keepSec);
    if (ops.length > 0) {
      session.stack.apply(applyEdlOps(session.stack.get(), ops));
    }
    return { snapshot: this.snapshot(sessionId, session), planned: ops.length };
  }

  /** 获取会话快照(不存在返回 null) */
  get(sessionId: string): TtSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this.snapshot(sessionId, session);
  }

  /** 取会话,不存在抛错 */
  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    return session;
  }

  /** 生成会话快照 */
  private snapshot(sessionId: string, session: Session): TtSessionSnapshot {
    const edl = session.stack.get();
    return {
      sessionId,
      videoPath: session.videoPath,
      durationSec: session.durationSec,
      segments: markDeletedSegments(edl, session.segments),
      edl,
      totalSec: totalDuration(edl),
      canUndo: session.stack.canUndo(),
      canRedo: session.stack.canRedo(),
    };
  }
}

/** 单例(IPC 层共享) */
export const textTimelineService = new TextTimelineService();
