/**
 * 非破坏性 EDL:构建与变换纯函数(PRD-文本即时间线 v2.0 FR-3)
 *
 * 职责:
 *   - EDL 构建(createEdl)与 cut/mute/move 变换(不可变,返回新 EDL)
 *   - 区间校验(越界/倒置拒绝),cut 相邻自动融合(保留片段模型下天然合并)
 *   - 批量应用(applyOps):一次应用多条 op,单条非法跳过并记录
 *
 * 区间规则(PRD 6.2):
 *   - cut 优先于 mute:cut 移除区间,mute 只在保留片段上打标
 *   - 嵌套/相邻 cut 天然融合(片段模型:反复移除保留区间即可)
 *   - move:抽取 [srcStart,srcEnd) 内的完整片段,插入到 dstIndex(越界自动钳制)
 */
import type { EDL, EdlClip, EditOp } from './types';

/** 片段 ID 计数器(进程内唯一,克隆时保持) */
let clipSeq = 0;

/** 重置片段 ID 计数器(测试用) */
export function resetClipSeq(): void {
  clipSeq = 0;
}

/** 分配片段 ID */
function nextClipId(): string {
  clipSeq += 1;
  return `clip-${clipSeq}`;
}

/**
 * 校验区间合法性
 * @param start 起点(秒)
 * @param end 终点(秒)
 * @param durationSec 源总时长(秒)
 * @returns 是否合法(start >= 0,end > start,end ≤ duration)
 */
export function isValidRange(start: number, end: number, durationSec: number): boolean {
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= durationSec + 1e-6
  );
}

/**
 * 创建初始 EDL:单一片段覆盖全片
 * @param sourcePath 源素材路径
 * @param durationSec 源总时长(秒)
 * @returns 初始 EDL
 */
export function createEdl(sourcePath: string, durationSec: number): EDL {
  resetClipSeq();
  return {
    sourcePath,
    durationSec,
    clips: [{ id: nextClipId(), srcStart: 0, srcEnd: durationSec }],
  };
}

/**
 * 深拷贝 EDL(clips 数组与新对象)
 */
function cloneEdl(edl: EDL): EDL {
  return {
    sourcePath: edl.sourcePath,
    durationSec: edl.durationSec,
    clips: edl.clips.map((c) => ({ ...c })),
  };
}

/**
 * cut:移除源时间轴 [start, end) 区间
 * 与保留片段重叠的部分被切开移除;相邻多次 cut 自动融合(片段模型天然合并)
 * @param edl 原 EDL(不修改)
 * @param start 删除起点(秒)
 * @param end 删除终点(秒)
 * @returns 新 EDL;区间非法返回原 EDL
 */
/**
 * 把区间钳制到 [0, durationSec] 并返回规范化起点/终点(纯函数)
 * 越界自动收缩;终点 ≤ 起点返回 null(无操作)
 * @param start 请求起点
 * @param end 终点
 * @param durationSec 源总时长
 * @returns { start, end } | null
 */
export function clampRange(
  start: number,
  end: number,
  durationSec: number,
): { start: number; end: number } | null {
  const s = Math.max(0, Math.min(Number(start), durationSec));
  const e = Math.max(0, Math.min(end, durationSec));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e - s <= 1e-6) return null;
  return { start: s, end: e };
}

/**
 * cut:移除源时间轴 [start, end) 素材
 * 与保留片段重叠的部分被移除,保留片段在边界处拆分;越界自动钳制
 * @param edl 原 EDL(不修改)
 * @param start 删除起点(秒)
 * @param end 删除终点(秒)
 * @returns 新 EDL;区间无效返回原状
 */
export function applyCut(edl: EDL, rawStart: number, rawEnd: number): EDL {
  const range = clampRange(rawStart, rawEnd, edl.durationSec);
  if (!range) return cloneEdl(edl);
  const start = range.start;
  const end = range.end;
  const out: EdlClip[] = [];
  for (const clip of edl.clips) {
    // 无重叠:原样保留
    if (clip.srcEnd <= start || clip.srcStart >= end) {
      out.push({ ...clip });
      continue;
    }
    // 重叠:保留切片左侧与右侧
    if (clip.srcStart < start) {
      out.push({ id: nextClipId(), srcStart: clip.srcStart, srcEnd: start, muted: clip.muted });
    }
    if (clip.srcEnd > end) {
      out.push({ id: nextClipId(), srcStart: end, srcEnd: clip.srcEnd, muted: clip.muted });
    }
  }
  return { ...edl, clips: out };
}

/**
 * mute:把 [start, end) 内的保留片段标记静音
 * 部分重叠的片段在边界处拆分,只静音重叠部分
 * @param edl 原 EDL(不修改)
 * @param start 静音起点(秒)
 * @param end 静音终点(秒)
 * @returns 新 EDL
 */
export function applyMute(edl: EDL, rawStart: number, rawEnd: number): EDL {
  const range = clampRange(rawStart, rawEnd, edl.durationSec);
  if (!range) return cloneEdl(edl);
  const start = range.start;
  const end = range.end;
  const out: EdlClip[] = [];
  for (const clip of edl.clips) {
    if (clip.srcEnd <= start || clip.srcStart >= end) {
      out.push({ ...clip });
      continue;
    }
    // 重叠区 [s, e)
    const s = Math.max(clip.srcStart, start);
    const e = Math.min(clip.srcEnd, end);
    if (clip.srcStart < s) {
      out.push({ id: nextClipId(), srcStart: clip.srcStart, srcEnd: s, muted: clip.muted });
    }
    out.push({ id: nextClipId(), srcStart: s, srcEnd: e, muted: true });
    if (clip.srcEnd > e) {
      out.push({ id: nextClipId(), srcStart: e, srcEnd: clip.srcEnd, muted: clip.muted });
    }
  }
  return { ...edl, clips: out };
}

/**
 * move:把 [srcStart, srcEnd) 内的保留片段移动到 dstIndex
 * 仅移动完全位于区间内的片段;dstIndex 越界自动钳制到 [0, clips.length]
 * @param edl 原 EDL(不修改)
 * @param srcStart 移动区间起点
 * @param srcEnd 移动区间终点
 * @param dstIndex 插入位置(以移动后的列表计)
 * @returns 新 EDL
 */
export function applyMove(
  edl: EDL,
  srcStart: number,
  srcEnd: number,
  dstIndex: number,
): EDL {
  const inside = edl.clips.filter((c) => c.srcStart >= srcStart && c.srcEnd <= srcEnd);
  if (inside.length === 0) return cloneEdl(edl);
  const rest: EdlClip[] = [];
  for (const c of edl.clips) {
    if (!inside.includes(c)) rest.push({ ...c });
  }
  const dst = Math.max(0, Math.min(dstIndex, rest.length));
  const moved = inside.map((c) => ({ ...c }));
  rest.splice(dst, 0, ...moved);
  return { ...edl, clips: rest };
}

/**
 * 保留片段总时长(导出成片时长)
 * @param edl EDL
 * @returns 总时长(秒)
 */
export function totalDuration(edl: EDL): number {
  return edl.clips.reduce((sum, c) => sum + (c.srcEnd - c.srcStart), 0);
}

/**
 * 批量按顺序应用操作
 * 非法操作(区间越界/倒置)跳过,不阻断其余
 * @param edl 原 EDL(不修改)
 * @param ops 操作列表
 * @returns 应用后的新 EDL
 */
export function applyOps(edl: EDL, ops: EditOp[]): EDL {
  let current = cloneEdl(edl);
  for (const op of ops) {
    if (op.op === 'cut') {
      current = applyCut(current, op.start, op.end);
    } else if (op.op === 'mute') {
      current = applyMute(current, op.start, op.end);
    } else if (op.op === 'move') {
      current = applyMove(current, op.srcStart, op.srcEnd, op.dstIndex);
    }
    // retune 不作用于 EDL(参数调节由导出阶段处理)
  }
  return current;
}
