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
import { ffmpegService } from '../ffmpeg';
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
import { TextTimelineExporter, type TextTimelineExportDeps, type EdlExportResult } from './exporter';
import {
  buildEditPlanPrompt,
  EDIT_PLAN_SYSTEM,
  parseEditPlan,
  sanitizeEditPlan,
} from './edit-plan';
import type { ChatMessage } from '../llm/types';
import { llmService } from '../llm';

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
  /** 导出依赖注入(默认真实 ffmpegService) */
  exportDeps?: TextTimelineExportDeps;
  /** LLM 聊天函数注入(默认 llmService.chat,温度 ≤0.3 由调用方保证) */
  llmChat?: (req: { messages: ChatMessage[]; temperature?: number; maxTokens?: number }) => Promise<{ content: string }>;
  /** 360p 代理生成注入(默认 ffmpegService.transcode;失败回退原片预览) */
  generateProxy?: (src: string, dest: string) => Promise<void>;
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
  /** 360p 代理文件路径(就绪后填充;预览与对话迭代打代理,导出仍用原片) */
  proxyPath?: string;
  /** 代理是否就绪(未就绪时渲染层回退原片预览) */
  proxyReady: boolean;
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
  /** 待确认的编辑计划(planId → ops) */
  plans: Map<string, EditOp[]>;
  /** 360p 代理路径(生成中为 undefined) */
  proxyPath?: string;
  /** 代理是否就绪 */
  proxyReady: boolean;
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
      plans: new Map(),
      proxyReady: false,
    };
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(sessionId, session);
    // 后台生成 360p 代理(PRD §6.2 决策 2:预览与对话迭代打代理,导出仍用原画质)
    this.startProxyGeneration(sessionId, session);
    logger.info(`[TextTimeline] 会话创建: ${sessionId} segs=${segments.length} dur=${durationSec.toFixed(2)}s`);
    return this.snapshot(sessionId, session);
  }

  /**
   * 后台生成 360p 代理(PRD §6.2 决策 2:预览与对话迭代打代理,导出仍用原画质)
   * 失败仅记日志,预览回退原片,不阻断会话
   */
  private startProxyGeneration(sessionId: string, session: Session): void {
    const proxyPath = `${session.videoPath.replace(/\.[^.]+$/, '')}.proxy-360p.mp4`;
    const generate =
      this.deps.generateProxy ??
      ((src: string, dest: string) =>
        ffmpegService.transcode(src, dest, {
          resolution: '640x360',
          videoBitrate: '500k',
          audioBitrate: '96k',
          preset: 'veryfast',
        }));
    void generate(session.videoPath, proxyPath)
      .then(() => {
        session.proxyPath = proxyPath;
        session.proxyReady = true;
        logger.info(`[TextTimeline] 代理就绪: ${proxyPath}`);
      })
      .catch((err: unknown) => {
        logger.warn(`[TextTimeline] 代理生成失败,预览回退原片: ${err instanceof Error ? err.message : String(err)}`);
      });
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

  /**
   * 导出成片:按当前 EDL 逐段裁剪 + 无损拼接 + 一致性校验
   * 原素材只读不修改(非破坏性)
   * @param sessionId 会话 ID
   * @param outputDir 输出目录
   * @param outputName 输出文件名(缺省自动命名)
   * @param token 取消令牌(可选,任务中心取消用)
   * @param onProgress 整体进度回调(0-100,可选)
   * @returns 导出结果(含一致性校验)
   */
  async exportEdl(
    sessionId: string,
    outputDir: string,
    outputName?: string,
    token?: import('../ffmpeg/types').CancelToken,
    onProgress?: (percent: number) => void,
  ): Promise<EdlExportResult> {
    const session = this.requireSession(sessionId);
    const exporter = new TextTimelineExporter(this.deps.exportDeps);
    return exporter.exportEdl({
      videoPath: session.videoPath,
      edl: session.stack.get(),
      outputDir,
      outputName,
      token,
      onProgress,
    });
  }

  /**
   * 对话式编辑:用户指令 → LLM 结构化编辑计划(PRD FR-4)
   * 指令含糊时返回 clarification 反问,不猜
   * @param sessionId 会话 ID
   * @param instruction 自然语言指令
   * @returns 计划(planId + 合法 ops)或澄清反问
   */
  async planEdits(
    sessionId: string,
    instruction: string,
  ): Promise<{ planId: string; ops: EditOp[] } | { clarification: string }> {
    const session = this.requireSession(sessionId);
    if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
      throw new Error('编辑指令不能为空');
    }
    const chat =
      this.deps.llmChat ??
      ((req: { messages: ChatMessage[]; temperature?: number; maxTokens?: number }) =>
        llmService.chat(req));
    const resp = await chat({
      messages: [
        { role: 'system', content: EDIT_PLAN_SYSTEM },
        {
          role: 'user',
          content: buildEditPlanPrompt(instruction.trim(), session.segments, session.durationSec),
        },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });
    const parsed = parseEditPlan(resp.content);
    if (parsed.clarification) {
      return { clarification: parsed.clarification };
    }
    const ops = sanitizeEditPlan(parsed.ops ?? [], session.segments, session.durationSec);
    if (ops.length === 0) {
      return {
        clarification:
          parsed.parseError ?? '未能从该指令解析出有效编辑操作,请换个说法(例如"删掉第 2 句")',
      };
    }
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.plans.set(planId, ops);
    return { planId, ops };
  }

  /**
   * 应用已确认的编辑计划(可勾选子集,默认全选)
   * @param sessionId 会话 ID
   * @param planId 计划 ID
   * @param indexes 选中 op 下标(缺省全部)
   * @returns 应用后的会话快照
   */
  applyPlan(sessionId: string, planId: string, indexes?: number[]): TtSessionSnapshot {
    const session = this.requireSession(sessionId);
    const ops = session.plans.get(planId);
    if (!ops) throw new Error(`编辑计划不存在: ${planId}`);
    const selected = Array.isArray(indexes) && indexes.length > 0
      ? (indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < ops.length) as number[]).map(
          (i) => ops[i],
        )
      : ops;
    if (selected.length > 0) {
      session.stack.apply(applyEdlOps(session.stack.get(), selected));
    }
    session.plans.delete(planId);
    return this.snapshot(sessionId, session);
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
      proxyPath: session.proxyPath,
      proxyReady: session.proxyReady,
    };
  }
}

/** 单例(IPC 层共享) */
export const textTimelineService = new TextTimelineService();
