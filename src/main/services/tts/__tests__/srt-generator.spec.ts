/**
 * SRT 字幕生成器纯函数单测
 * 职责:验证 formatSrtTime 时间戳格式化(负数/进位/补零)、buildSrtEntries 累计时间轴与最小显示时长、
 *      serializeSrt 序列化格式、generateSrtContent 一步生成
 * 运行:npm run test 或 node --test --import tsx src/main/services/tts/__tests__/srt-generator.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSrtTime,
  buildSrtEntries,
  serializeSrt,
  generateSrtContent,
} from '../srt-generator.ts';
import type { ChunkSynthesisResult } from '../types.ts';

/** 构造一个分片合成结果 */
function chunk(text: string, durationSec: number): ChunkSynthesisResult {
  return { text, durationSec } as ChunkSynthesisResult;
}

describe('formatSrtTime', () => {
  it('0 秒格式化为 00:00:00,000', () => {
    assert.equal(formatSrtTime(0), '00:00:00,000');
  });

  it('普通秒数格式化为 HH:MM:SS,mmm', () => {
    assert.equal(formatSrtTime(1.5), '00:00:01,500');
    assert.equal(formatSrtTime(3661), '01:01:01,000');
  });

  it('毫秒进位(999ms 四舍五入进位到秒)', () => {
    // 0.9995 * 1000 → Math.round = 1000ms,进位到 1 秒
    assert.equal(formatSrtTime(0.9995), '00:00:01,000');
    // 0.999 四舍五入为 999ms,不进位
    assert.equal(formatSrtTime(0.999), '00:00:00,999');
  });

  it('负数与 NaN 归零', () => {
    assert.equal(formatSrtTime(-5), '00:00:00,000');
    assert.equal(formatSrtTime(NaN), '00:00:00,000');
    assert.equal(formatSrtTime(Infinity), '00:00:00,000');
  });
});

describe('buildSrtEntries', () => {
  it('按累计时长生成从 1 开始的有序条目', () => {
    const entries = buildSrtEntries([chunk('第一句', 1.5), chunk('第二句', 2.0)], 1.0);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].index, 1);
    assert.equal(entries[0].startTime, '00:00:00,000');
    assert.equal(entries[0].endTime, '00:00:01,500');
    assert.equal(entries[0].text, '第一句');
    // 第二条从第一条结束处开始
    assert.equal(entries[1].startTime, '00:00:01,500');
    assert.equal(entries[1].endTime, '00:00:03,500');
  });

  it('实际时长不足最小显示时长时补足', () => {
    const entries = buildSrtEntries([chunk('短', 0.2)], 1.0);
    assert.equal(entries[0].endTime, '00:00:01,000');
  });

  it('空分片数组返回空数组', () => {
    assert.deepEqual(buildSrtEntries([]), []);
  });
});

describe('serializeSrt', () => {
  it('序列化为标准 SRT 格式', () => {
    const text = serializeSrt([
      {
        index: 1,
        startTime: '00:00:00,000',
        endTime: '00:00:01,500',
        text: '你好',
      },
    ]);
    assert.equal(text, '1\n00:00:00,000 --> 00:00:01,500\n你好\n');
  });
});

describe('generateSrtContent', () => {
  it('一步生成完整 SRT 内容', () => {
    const out = generateSrtContent([chunk('你好', 1.0), chunk('世界', 1.0)], 1.0);
    assert.ok(out.includes('1\n00:00:00,000 --> 00:00:01,000\n你好\n'));
    assert.ok(out.includes('2\n00:00:01,000 --> 00:00:02,000\n世界\n'));
  });
});
