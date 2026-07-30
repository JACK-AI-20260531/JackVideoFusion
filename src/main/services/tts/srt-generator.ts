/**
 * SRT 字幕生成器
 * 职责:将分片级合成结果(文本 + 实际音频时长)按累计时间轴
 *      生成符合 SRT 标准的字幕文件,保证字幕与音频对齐
 */

import type { ChunkSynthesisResult } from './types';

/** 单个 SRT 条目 */
export interface SrtEntry {
  /** 序号(1-based) */
  index: number;
  /** 起始时间,格式 HH:MM:SS,mmm */
  startTime: string;
  /** 结束时间,格式 HH:MM:SS,mmm */
  endTime: string;
  /** 字幕文本 */
  text: string;
}

/**
 * 将秒数(可含小数)格式化为 SRT 时间戳 HH:MM:SS,mmm
 * @param totalSec 总秒数
 * @returns SRT 时间戳字符串
 */
export function formatSrtTime(totalSec: number): string {
  // 处理负数或 NaN,确保下限为 0
  const safe = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
  const wholeSec = Math.floor(safe);
  const milliseconds = Math.round((safe - wholeSec) * 1000);

  // 处理进位(例如 999ms + 1ms = 1000ms)
  const carrySec = Math.floor(milliseconds / 1000);
  const finalMs = milliseconds % 1000;
  const sec = wholeSec + carrySec;

  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  // 三位补零
  const pad3 = (n: number): string => n.toString().padStart(3, '0');
  const pad2 = (n: number): string => n.toString().padStart(2, '0');

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(finalMs)}`;
}

/**
 * 按分片累计时长生成 SRT 条目列表
 * 每个分片对应一条 SRT 条目,时间轴由前序分片时长累加得到
 * @param chunks 分片合成结果(已按顺序排列)
 * @param minDurationSec 单条字幕最小显示时长,默认 1.0 秒(避免短句一闪而过)
 * @returns SRT 条目数组
 */
export function buildSrtEntries(chunks: ChunkSynthesisResult[], minDurationSec: number = 1.0): SrtEntry[] {
  const entries: SrtEntry[] = [];
  let cursorSec = 0; // 累计时间游标

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const startSec = cursorSec;
    // 实际时长若不足最小显示时长,则补足;否则使用实际估算时长
    const endSec = startSec + Math.max(chunk.durationSec, minDurationSec);
    cursorSec = endSec;

    entries.push({
      index: i + 1,
      startTime: formatSrtTime(startSec),
      endTime: formatSrtTime(endSec),
      text: chunk.text,
    });
  }

  return entries;
}

/**
 * 将 SRT 条目数组序列化为标准 SRT 文件内容
 * @param entries SRT 条目数组
 * @returns SRT 文件文本(UTF-8,行尾 \n)
 */
export function serializeSrt(entries: SrtEntry[]): string {
  return entries
    .map((entry) => `${entry.index}\n${entry.startTime} --> ${entry.endTime}\n${entry.text}\n`)
    .join('\n');
}

/**
 * 一步生成 SRT 文件文本(便捷方法)
 * @param chunks 分片合成结果
 * @param minDurationSec 单条字幕最小显示时长
 * @returns SRT 文件文本
 */
export function generateSrtContent(chunks: ChunkSynthesisResult[], minDurationSec: number = 1.0): string {
  return serializeSrt(buildSrtEntries(chunks, minDurationSec));
}
