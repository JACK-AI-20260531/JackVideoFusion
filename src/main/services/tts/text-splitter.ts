/**
 * 长文本分片器
 * 职责:将超长文本(可高达 5W 字符)按句号/换行/段落切分为
 *      不超过 maxChars 字符的多个分片,保证:
 *      1) 不破坏句子完整性(优先在句末标点后切分)
 *      2) 不截断多字节字符(基于 Array.from 安全切片)
 *      3) 保留每个分片在原文中的偏移 offset,用于 SRT 对齐
 */

/** 单个分片的描述 */
export interface TextChunk {
  /** 分片序号(0-based) */
  index: number;
  /** 分片纯文本(已 trim) */
  text: string;
  /** 在原文本中的起始字符偏移(基于码点) */
  offset: number;
}

/** 单分片字符上限(msedge-tts 单次合成推荐 ≤500 字符以保证稳定流式输出) */
export const DEFAULT_MAX_CHARS = 500;

/** 视为句子结束的标点(中英文句号、问号、感叹号、省略号) */
const SENTENCE_TERMINATORS = new Set([
  '。',
  '!',
  '!',
  '?',
  '?',
  '…',
  ';',
  ';',
]);

/** 视为段落的分隔符 */
const PARAGRAPH_BREAKS = new Set(['\n', '\r', '\u2029']);

/**
 * 判断字符是否为句子结束标点
 * @param ch 待判定字符
 * @returns 是否句子结束
 */
function isSentenceEnd(ch: string): boolean {
  return SENTENCE_TERMINATORS.has(ch);
}

/**
 * 判断字符是否为段落分隔符
 * @param ch 待判定字符
 * @returns 是否段落分隔
 */
function isParagraphBreak(ch: string): boolean {
  return PARAGRAPH_BREAKS.has(ch);
}

/**
 * 将任意字符串转为码点数组,避免 4 字节 emoji/生僻字被截断
 * @param text 原始字符串
 * @returns 码点数组
 */
function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 在 [start, end) 区间内反向查找最后一个句子结束位置
 * @param codePoints 码点数组
 * @param start 搜索起点(包含)
 * @param end 搜索终点(不包含)
 * @returns 最后一个句子结束标点的下标 + 1(即下一分片起点),未找到返回 -1
 */
function findLastSentenceBoundary(codePoints: string[], start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    if (isSentenceEnd(codePoints[i])) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 将一段超长文本切分为多个不超过 maxChars 的分片
 * 切分优先级:段落换行 > 句子结束 > 硬切(超长单句)
 * @param text 原始文本,可长达 5W 字符
 * @param maxChars 单分片字符上限,默认 500
 * @returns 分片数组(至少返回 1 个分片,空文本返回空数组)
 */
export function splitLongText(text: string, maxChars: number = DEFAULT_MAX_CHARS): TextChunk[] {
  // 空文本直接返回空数组,避免产生空分片
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // 转码点数组,确保多字节字符安全
  const codePoints = toCodePoints(trimmed);
  const total = codePoints.length;
  const chunks: TextChunk[] = [];

  let cursor = 0; // 当前分片在码点数组中的起点
  let chunkIndex = 0; // 分片序号

  while (cursor < total) {
    // 剩余字符已不足 maxChars,直接收尾
    if (total - cursor <= maxChars) {
      const slice = codePoints.slice(cursor, total).join('').trim();
      if (slice.length > 0) {
        chunks.push({ index: chunkIndex++, text: slice, offset: cursor });
      }
      break;
    }

    // 计算下一分片的候选终点
    const proposedEnd = cursor + maxChars;

    // 第 1 优先级:在 [cursor, proposedEnd) 内寻找段落分隔
    let cutAt = -1;
    for (let i = proposedEnd - 1; i > cursor; i--) {
      if (isParagraphBreak(codePoints[i])) {
        cutAt = i + 1;
        break;
      }
    }

    // 第 2 优先级:在 [cursor, proposedEnd) 内寻找最后一个句子结束标点
    if (cutAt === -1) {
      cutAt = findLastSentenceBoundary(codePoints, cursor, proposedEnd);
    }

    // 第 3 优先级:在 [cursor, proposedEnd) 内寻找最后一个空格(英文回退)
    if (cutAt === -1) {
      for (let i = proposedEnd - 1; i > cursor; i--) {
        if (codePoints[i] === ' ') {
          cutAt = i + 1;
          break;
        }
      }
    }

    // 第 4 优先级:硬切(超长单句无标点)
    if (cutAt === -1 || cutAt <= cursor) {
      cutAt = proposedEnd;
    }

    const slice = codePoints.slice(cursor, cutAt).join('').trim();
    if (slice.length > 0) {
      chunks.push({ index: chunkIndex++, text: slice, offset: cursor });
    }
    cursor = cutAt;
  }

  return chunks;
}

/**
 * 校验文本长度是否在硬性上限内
 * @param text 待校验文本
 * @param limit 字符上限,默认 50000
 * @returns 是否在限制内
 */
export function isWithinCharLimit(text: string, limit: number = 50000): boolean {
  return Array.from(text).length <= limit;
}
