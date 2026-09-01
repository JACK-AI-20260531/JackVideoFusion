/**
 * 转写文本 → 句级段落与编辑计划纯函数(PRD-文本即时间线 v2.0 FR-1/FR-2)
 *
 * 职责:
 *   - SRT 文本 → 句级 TextSegment[](段对齐)
 *   - 一键清理口头禅 → cut 操作列表(词级时间戳存在时词级剪,缺省时整句剪)
 *   - 压缩停顿:段间静音 > 阈值时生成 cut(保留 keepSec 余量)
 *
 * 设计要点:
 *   - 全部纯函数,不依赖 electron/ffmpeg,可独立单测
 *   - 剪辑点向后外扩 MARGIN_SEC 余量(PRD 8 风险:词级时间戳不准)
 */
import type { EditOp, TextSegment, WordTiming } from './types';

/** 默认口头禅词表(可自定义) */
export const DEFAULT_FILLER_WORDS = ['嗯', '啊', '然后', '就是', '那个'];

/** 剪辑点外扩余量(秒) */
export const CUT_MARGIN_SEC = 0.15;

/** 压缩停顿阈值(秒):段间静音超过该值才压缩 */
export const PAUSE_THRESHOLD_SEC = 0.8;

/** 压缩后保留的停顿余量(秒) */
export const PAUSE_KEEP_SEC = 0.2;

/** SRT 时间戳 00:01:02,500 / 00:01:02.500 → 秒 */
export function parseTimestamp(ts: string): number {
  const m = ts.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * SRT 文本 → 句级段落(纯函数)
 * 解析序号行/时间轴行/文本行;时间非法的块跳过
 * @param srt SRT 文件内容
 * @returns 句级段落列表(按时间升序)
 */
export function parseSrtToSegments(srt: string): TextSegment[] {
  const blocks = srt.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const segments: TextSegment[] = [];
  let index = 0;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => /-->/.test(l));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split('-->');
    const start = parseTimestamp(startRaw ?? '');
    const end = parseTimestamp(endRaw ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l.trim()));
    if (textLines.length === 0) continue;
    index++;
    segments.push({
      id: `seg-${index}`,
      text: textLines.join(' ').trim(),
      start,
      end: Math.max(end, start),
    });
  }
  return segments;
}

/** 去除常见标点与空白(口头禅匹配用) */
function stripPunctuation(text: string): string {
  return text.replace(/[。，、！？!?,.\s'"'""…—-]/g, '');
}

/** 词级时间戳中查找与口头禅匹配的区间(含外扩余量) */
function wordFillerCuts(words: WordTiming[], fillers: string[]): { start: number; end: number }[] {
  const cuts: { start: number; end: number }[] = [];
  for (const w of words) {
    if (fillers.includes(w.text.replace(/[。，、！？!?,.\s]/g, ''))) {
      cuts.push({ start: Math.max(0, w.start - CUT_MARGIN_SEC), end: w.end + CUT_MARGIN_SEC });
    }
  }
  return cuts;
}

/**
 * 生成"一键清理口头禅"的 cut 操作列表(纯函数)
 * 规则:
 *   1. 词级时间戳存在 → 精确剪掉口头禅词区间(前后外扩 0.15s);
 *   2. 无词级时间戳且整句(去标点后)恰为口头禅 → 剪掉整句;
 * @param segments 句级段落
 * @param fillers 口头禅词表(默认 嗯/啊/然后/就是/那个)
 * @returns cut 操作列表(按时间升序)
 */
export function planFillerCuts(
  segments: TextSegment[],
  fillers: string[] = DEFAULT_FILLER_WORDS,
): EditOp[] {
  const ops: EditOp[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      for (const range of wordFillerCuts(seg.words, fillers)) {
        ops.push({
          op: 'cut',
          start: range.start,
          end: range.end,
          reason: '口头禅(词级)',
        });
      }
      continue;
    }
    const bare = stripPunctuation(seg.text);
    if (fillers.includes(bare)) {
      ops.push({
        op: 'cut',
        start: Math.max(0, seg.start - CUT_MARGIN_SEC),
        end: seg.end + CUT_MARGIN_SEC,
        reason: '口头禅(整句)',
      });
    }
  }
  return ops;
}

/**
 * 生成"压缩停顿"的 cut 操作列表(纯函数)
 * 相邻段落间静音 > thresholdSec 时,段尾保留 keepSec 秒,剪掉其余
 * @param segments 句级段落(按时间升序)
 * @param thresholdSec 压缩阈值(默认 0.8s)
 * @param keepSec 保留停顿余量(默认 0.2s)
 * @returns cut 操作列表
 */
export function planPauseCompression(
  segments: TextSegment[],
  thresholdSec = PAUSE_THRESHOLD_SEC,
  keepSec = 0.2,
): EditOp[] {
  const ops: EditOp[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prevEnd = segments[i - 1].end;
    const nextStart = segments[i].start;
    const gap = nextStart - prevEnd;
    if (Number.isFinite(gap) && gap > thresholdSec) {
      const cutStart = prevEnd + Math.min(keepSec, gap / 2);
      if (nextStart - cutStart > 1e-6) {
        ops.push({
          op: 'cut',
          start: cutStart,
          end: nextStart,
          reason: `压缩停顿(保留 ${Math.min(keepSec, gap).toFixed(2)}s)`,
        });
      }
    }
  }
  return ops;
}
