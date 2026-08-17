/**
 * 逐镜头配音脚本分配纯函数单测
 * 职责:覆盖 splitParagraphs / assignShotScripts / computeRateForMatch 的分配与估算逻辑
 * 运行:node --test --import tsx src/main/services/film-dub-clone/__tests__/segment-script.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitParagraphs,
  assignShotScripts,
  computeRateForMatch,
  estimateDurationSec,
  calculateRateCorrection,
} from '../segment-script.ts';

describe('splitParagraphs', () => {
  it('按句号/换行/问号/感叹号切分并过滤空段', () => {
    const parts = splitParagraphs('第一句。第二句\n第三句？第四句！');
    assert.deepEqual(parts, ['第一句', '第二句', '第三句', '第四句']);
  });

  it('空串返回空数组', () => {
    assert.deepEqual(splitParagraphs(''), []);
    assert.deepEqual(splitParagraphs('   '), []);
  });
});

describe('assignShotScripts', () => {
  it('段落数 = 镜头数时一对一分配,时间轴按镜头时长累加', () => {
    const segs = assignShotScripts('A。B。C。', [2, 3, 4]);
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[0], { index: 0, text: 'A', startSec: 0, durationSec: 2 });
    assert.deepEqual(segs[1], { index: 1, text: 'B', startSec: 2, durationSec: 3 });
    assert.deepEqual(segs[2], { index: 2, text: 'C', startSec: 5, durationSec: 4 });
  });

  it('段落数 < 镜头数时,多余镜头无字幕(空串)', () => {
    const segs = assignShotScripts('A。B。', [2, 3, 4]);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].text, 'A');
    assert.equal(segs[1].text, 'B');
    assert.equal(segs[2].text, '');
  });

  it('段落数 > 镜头数时,多余段落追加到最后一个镜头,避免丢文案', () => {
    const segs = assignShotScripts('A。B。C。D。E。', [2, 3]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].text, 'A');
    // 镜头1:本段 B + 追加的 C、D、E,用顿号拼接
    assert.equal(segs[1].text, 'B。C。D。E');
  });

  it('空文案时所有镜头字幕为空,时间轴仍连续', () => {
    const segs = assignShotScripts('', [2, 3]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].text, '');
    assert.equal(segs[1].text, '');
    assert.equal(segs[1].startSec, 2);
  });
});

describe('computeRateForMatch', () => {
  it('文本越长、目标时长越短 → rate 越大(加快)', () => {
    // 18 字符 / 4.5 = 4s 自然时长;目标 2s → 倍率 2 → rate 100,clamp 到 60
    const rate = computeRateForMatch('一二三四五六七八九十一二三四五六七八九', 2);
    assert.equal(rate, 60);
  });

  it('文本刚好匹配目标时长 → rate 接近 0', () => {
    // 9 字符 / 4.5 = 2s,目标 2s → 倍率 1 → rate 0
    const rate = computeRateForMatch('一二三四五六七八九', 2);
    assert.equal(rate, 0);
  });

  it('文本短于目标时长 → rate 为负(放慢),但不下穿下限', () => {
    // 9 字符 / 4.5 = 2s,目标 10s → 倍率 0.2 → rate -80,clamp 到 -20
    const rate = computeRateForMatch('一二三四五六七八九', 10);
    assert.equal(rate, -20);
  });

  it('空文本或非法时长返回 0', () => {
    assert.equal(computeRateForMatch('', 5), 0);
    assert.equal(computeRateForMatch('AB', 0), 0);
    assert.equal(computeRateForMatch('AB', -1), 0);
  });
});

describe('estimateDurationSec', () => {
  it('纯中文按 CJK_CHARS_PER_SEC 估算(9 字 → 2s)', () => {
    assert.ok(Math.abs(estimateDurationSec('一二三四五六七八九') - 2) < 1e-6);
  });

  it('英文按词级估算(1 词 → 0.35s)', () => {
    assert.equal(estimateDurationSec('hello'), 0.35);
  });

  it('数字按位估算(3 位 → 0.45s)', () => {
    assert.ok(Math.abs(estimateDurationSec('123') - 0.45) < 1e-6);
  });

  it('句末标点计入停顿(2 字 + 句号)', () => {
    /** 2 汉字(2/4.5≈0.444) + 句号(0.45) ≈ 0.894 */
    const val = estimateDurationSec('你好。');
    assert.ok(Math.abs(val - (2 / 4.5 + 0.45)) < 1e-6);
  });

  it('混合文本:英文词 + 数字 + 英文词', () => {
    // word(0.35) + digit2(0.30) + word(0.35) ≈ 1.0
    assert.ok(Math.abs(estimateDurationSec('iPhone 15 Pro') - 1.0) < 1e-6);
  });

  it('空文本返回 0', () => {
    assert.equal(estimateDurationSec(''), 0);
    assert.equal(estimateDurationSec('   '), 0);
  });
});

describe('calculateRateCorrection', () => {
  it('配音超时 → 加快(rate 增大,clamp 到上限)', () => {
    // actual=2,target=1 → delta=1 → prev(0)+100 → clamp 60
    assert.equal(calculateRateCorrection(0, 2, 1), 60);
  });

  it('配音过短 → 放慢(rate 减小,clamp 到下限)', () => {
    // actual=0.5,target=1 → delta=-0.5 → prev(0)-50 → clamp -20
    assert.equal(calculateRateCorrection(0, 0.5, 1), -20);
  });

  it('时长匹配 → rate 不变', () => {
    assert.equal(calculateRateCorrection(10, 5, 5), 10);
  });

  it('非法目标时长 → 返回原 rate', () => {
    assert.equal(calculateRateCorrection(15, 3, 0), 15);
    assert.equal(calculateRateCorrection(15, 3, -1), 15);
  });
});
