/**
 * OCR 字幕合并与 SRT 序列化单测
 * 职责:验证文本清洗、相似度、字幕分段合并、SRT 时间戳与序列化
 * 说明:纯函数,不依赖 electron/引擎/ffmpeg,可在纯 Node 环境直接测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/srt-builder.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOcrText,
  textSimilarity,
  buildSubtitleLines,
  formatTimeline,
  formatSrt,
} from '../srt-builder.ts';
import type { FrameOcrResult } from '../types.ts';

/** 构造帧序列(按时间升序),自动把文本数组映射为帧 */
function frames(...items: Array<[number, string]>): FrameOcrResult[] {
  return items.map(([timeSec, text]) => ({ timeSec, text }));
}

describe('normalizeOcrText', () => {
  it('压缩空白与换行为单空格', () => {
    assert.equal(normalizeOcrText('  你好\n  世界  '), '你好 世界');
  });

  it('空字符串返回空', () => {
    assert.equal(normalizeOcrText(''), '');
    assert.equal(normalizeOcrText('   \n '), '');
  });
});

describe('textSimilarity', () => {
  it('相同文本为 1', () => {
    assert.equal(textSimilarity('你好世界', '你好世界'), 1);
  });

  it('空字符串与空字符串为 1,空与非空为 0', () => {
    assert.equal(textSimilarity('', ''), 1);
    assert.equal(textSimilarity('', '你好'), 0);
    assert.equal(textSimilarity('你好', ''), 0);
  });

  it('相似文本(仅空格差异)相似度高', () => {
    // 去空白后字符集合相同 → 相似度 1
    assert.equal(textSimilarity('人工智能', '人工智能'), 1);
    // 缺一个字但仍高度重叠 → 相似度高(接近 1)
    const s = textSimilarity('人工智能剪辑', '人工智剪辑');
    assert.ok(s > 0.8 && s < 1);
    // 明显不同文本相似度低
    assert.ok(textSimilarity('人工智能', '天气不错') < 0.5);
  });
});

describe('formatTimeline', () => {
  it('输出 HH:MM:SS,mmm 格式', () => {
    assert.equal(formatTimeline(1.5), '00:00:01,500');
    assert.equal(formatTimeline(0), '00:00:00,000');
    assert.equal(formatTimeline(3661.25), '01:01:01,250');
  });

  it('负数按 0 处理', () => {
    assert.equal(formatTimeline(-2), '00:00:00,000');
  });
});

describe('buildSubtitleLines', () => {
  it('空输入返回空数组', () => {
    assert.deepEqual(buildSubtitleLines([]), []);
    assert.deepEqual(buildSubtitleLines([{ timeSec: 0, text: '   ' }]), []);
  });

  it('连续相同文本帧合并为一段', () => {
    const segs = buildSubtitleLines(
      frames([0.5, '你好世界'], [1.5, '你好 世界'], [2.5, '你好 世界']),
      { intervalSec: 1 },
    );
    assert.equal(segs.length, 1);
    // 开始时间取首帧,结束时间取末段之后的下一段不存在 → start + interval
    assert.equal(segs[0].startSec, 0.5);
    assert.equal(segs[0].endSec, 3.5);
    assert.ok(segs[0].text.includes('你好'));
  });

  it('文本显著变化时切分为多段', () => {
    const segs = buildSubtitleLines(
      frames([0.5, 'aaa'], [1.5, 'aaa'], [2.5, 'bbb'], [3.5, 'bbb']),
      { intervalSec: 1 },
    );
    // 第一段 start 0.5,end 2.5(收敛到下一段开始);第二段 start 2.5
    assert.equal(segs.length, 2);
    assert.equal(segs[0].startSec, 0.5);
    assert.equal(segs[0].endSec, 2.5);
    assert.equal(segs[1].startSec, 2.5);
    assert.equal(segs[1].endSec, 4.5);
  });

  it('过短片段被过滤(长度 < minDuration)', () => {
    const segs = buildSubtitleLines(
      frames([0.5, 'aa'], [1.5, 'bb'], [2.5, 'bb'], [3.5, 'bb']),
      { intervalSec: 1, minDurationSec: 2 },
    );
    // 首段只有 1s(0.5→1.5)被过滤;第二段 3s(1.5→4.5)与 'bb' 保留
    assert.equal(segs.length, 1);
    assert.ok(segs[0].text.includes('bb'));
  });

  it('无文本帧被忽略', () => {
    const segs = buildSubtitleLines(
      frames([0.5, ''], [1.5, '有效字幕'], [2.5, '有效字幕']),
      { intervalSec: 1 },
    );
    assert.equal(segs.length, 1);
    assert.equal(segs[0].startSec, 1.5);
  });
});

describe('formatSrt', () => {
  it('生成带序号、时间轴与文本的 SRT', () => {
    const srt = formatSrt([{ startSec: 0.5, endSec: 2.5, text: '你好世界' }]);
    assert.ok(srt.startsWith('1\n00:00:00,500 --> 00:00:02,500\n你好世界'));
  });

  it('空数组返回空字符串', () => {
    assert.equal(formatSrt([]), '');
  });
});
