/**
 * OCR 字幕合并与 SRT 序列化(纯函数)
 *
 * 职责:
 *   - buildSubtitleLines:把带时间戳的逐帧 OCR 结果按文本连续段合并为字幕行
 *   - formatSrt:把字幕行序列化为 SRT 标准文本
 *   - normalizeOcrText / textSimilarity:文本清洗与相似度(供合并判等使用)
 *
 * 设计约定:
 *   - 不依赖 electron/引擎/ffmpeg,可独立单元测试
 *   - 相邻帧文本"足够相似"则并入同一段,否则开启新段
 *   - 过短的字幕段被丢弃,避免噪声
 */
import type { FrameOcrResult, SubtitleLine } from './types';

/** 合并选项 */
export interface SrtMergeOptions {
  /** 抽帧间隔(秒),用于计算每段字幕的结束时间,默认 1 */
  intervalSec?: number;
  /** 帧间文本相似阈值(0-1),默认 0.6 */
  similarityThreshold?: number;
  /** 最短字幕时长(秒),默认 1 */
  minDurationSec?: number;
}

/** 默认抽帧间隔 */
const DEFAULT_INTERVAL = 1;
/** 默认相似阈值 */
const DEFAULT_THRESHOLD = 0.6;
/** 默认最短字幕时长 */
const DEFAULT_MIN_DURATION = 1;

/**
 * 清洗 OCR 原始文本(去空白、压缩空格、去除纯噪声行)
 * @param raw OCR 原始文本
 * @returns 清洗后的单行文本
 */
export function normalizeOcrText(raw: string): string {
  if (!raw) return '';
  // 统一换行为空格,压缩连续空白,去除首尾空白
  const t = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/**
 * 计算两段文本的字符集合相似度(Jaccard)
 * 对 OCR 中常见的空格差异、个别错字具有一定鲁棒性
 * @param a 文本 A
 * @param b 文本 B
 * @returns 相似度 0-1(空字符串碰撞为 1)
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return a === b ? 1 : 0;
  const setA = new Set(Array.from(a));
  const setB = new Set(Array.from(b));
  let inter = 0;
  for (const ch of setA) {
    if (setB.has(ch)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * 把逐帧 OCR 结果按文本连续段合并为字幕行
 * 输入的 frames 需按 timeSec 升序。
 * @param frames 帧识别结果序列(升序 by timeSec)
 * @param opts 合并选项
 * @returns 字幕行数组(已过滤过短段、按时间升序)
 */
export function buildSubtitleLines(
  frames: FrameOcrResult[],
  opts?: SrtMergeOptions,
): SubtitleLine[] {
  const interval = opts?.intervalSec && opts.intervalSec > 0 ? opts.intervalSec : DEFAULT_INTERVAL;
  const threshold =
    opts?.similarityThreshold !== undefined
      ? Math.min(1, Math.max(0, opts.similarityThreshold))
      : DEFAULT_THRESHOLD;
  const minDuration =
    opts?.minDurationSec !== undefined && opts.minDurationSec > 0
      ? opts.minDurationSec
      : DEFAULT_MIN_DURATION;

  if (!frames || frames.length === 0) return [];

  // 清洗后的帧序列(仅保留有文本的帧)
  const cleaned: { timeSec: number; text: string }[] = [];
  for (const f of frames) {
    const text = normalizeOcrText(f.text);
    if (text.length > 0) {
      cleaned.push({ timeSec: f.timeSec, text });
    }
  }
  if (cleaned.length === 0) return [];

  // 贪心分段:遍历帧,相邻相似则归并,记录每段末帧时间与文本
  const segments: { startSec: number; lastTimeSec: number; text: string }[] = [];
  let cur = {
    startSec: cleaned[0].timeSec,
    lastTimeSec: cleaned[0].timeSec,
    text: cleaned[0].text,
  };
  for (let i = 1; i < cleaned.length; i++) {
    const f = cleaned[i];
    // 与当前段末尾文本比较
    if (textSimilarity(cur.text, f.text) >= threshold) {
      // 相似:并入当前段(文本取两者中较长者,避免被空白变体覆盖)
      cur.lastTimeSec = f.timeSec;
      if (f.text.length > cur.text.length) cur.text = f.text;
    } else {
      // 不相似:结束当前段,开启新段
      segments.push(cur);
      cur = { startSec: f.timeSec, lastTimeSec: f.timeSec, text: f.text };
    }
  }
  segments.push(cur);

  // 转成带结束时间的字幕行,并过滤过短段
  // 一段的结束时间 = 末帧时间 + interval;若与下一段重叠则收敛到下一段开始
  const lines: SubtitleLine[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const rawEnd = seg.lastTimeSec + interval;
    const nextStart = i + 1 < segments.length ? segments[i + 1].startSec : undefined;
    let endSec = nextStart !== undefined ? Math.min(rawEnd, nextStart) : rawEnd;
    if (endSec <= seg.startSec) endSec = seg.startSec + 0.1;
    const duration = endSec - seg.startSec;
    if (duration >= minDuration) {
      lines.push({ startSec: seg.startSec, endSec, text: seg.text });
    }
  }
  return lines;
}

/**
 * 把秒数格式化为 SRT 时间戳 HH:MM:SS,mmm
 * @param sec 秒数
 * @returns 形如 "00:00:01,500" 的字符串
 */
export function formatTimeline(sec: number): string {
  const s = Math.max(0, sec);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);
  const millis = Math.floor((s - Math.floor(s)) * 1000);
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * 把字幕行序列化为 SRT 标准文本
 * @param lines 字幕行数组
 * @returns SRT 内容(以 \n 分隔,末尾无多余空行)
 */
export function formatSrt(lines: SubtitleLine[]): string {
  if (!lines || lines.length === 0) return '';
  const blocks: string[] = [];
  lines.forEach((line, idx) => {
    const start = formatTimeline(line.startSec);
    const end = formatTimeline(line.endSec);
    blocks.push(`${idx + 1}\n${start} --> ${end}\n${line.text}`);
  });
  return blocks.join('\n\n');
}
