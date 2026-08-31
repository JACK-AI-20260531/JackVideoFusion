/**
 * 爆款评分 prompt 组装与容错解析单测
 * 职责:验证 truncateTranscript 截断、buildViralityPrompt 批量消息构造、
 *      computeViralityScore 加权综合、parseViralityReports JSON 容错解析与失败隔离
 * 运行:npm run test 或 node --test --import tsx src/main/services/ai-slice/__tests__/virality.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRALITY_SYSTEM,
  truncateTranscript,
  buildViralityPrompt,
  computeViralityScore,
  parseViralityReports,
} from '../virality.ts';

describe('truncateTranscript', () => {
  it('不超过上限时原样返回', () => {
    assert.equal(truncateTranscript('你好', 10), '你好');
    assert.equal(truncateTranscript('1234567890', 10), '1234567890');
  });

  it('超长时截断并以省略号结尾', () => {
    const out = truncateTranscript('a'.repeat(21), 20);
    assert.equal(out.length, 21);
    assert.ok(out.endsWith('…'));
    assert.ok(out.startsWith('a'.repeat(20)));
  });
});

describe('buildViralityPrompt', () => {
  it('包含切片索引、时长与转写摘要,转写超长被截断', () => {
    const prompt = buildViralityPrompt(
      [
        { index: 1, durationSec: 12.4, transcript: '大家好,今天聊聊剪辑。' },
        { index: 2, durationSec: 30.9, transcript: 'x'.repeat(300) },
      ],
      200,
    );
    assert.ok(prompt.includes('2 条切片'));
    assert.ok(prompt.includes('切片 1'));
    assert.ok(prompt.includes('12 秒'));
    assert.ok(prompt.includes('大家好,今天聊聊剪辑。'));
    // 300 字转写被截断到 200 + 省略号
    assert.ok(prompt.includes(`${'x'.repeat(200)}…`));
    assert.ok(!prompt.includes('x'.repeat(201)));
  });

  it('空转写显示占位符', () => {
    const prompt = buildViralityPrompt([{ index: 3, durationSec: 9, transcript: '' }]);
    assert.ok(prompt.includes('(无语音内容)'));
  });
});

describe('computeViralityScore', () => {
  it('按 0.25/0.2/0.25/0.2/0.1 权重加权并四舍五入', () => {
    assert.equal(computeViralityScore({ hook: 100, emotion: 100, topic: 100, retention: 100, titleability: 100 }), 100);
    assert.equal(computeViralityScore({ hook: 0, emotion: 0, topic: 0, retention: 0, titleability: 0 }), 0);
    // 0.25*100 = 25
    assert.equal(computeViralityScore({ hook: 100, emotion: 0, topic: 0, retention: 0, titleability: 0 }), 25);
    // 0.2*50 + 0.2*50 + 0.1*100 = 30
    assert.equal(
      computeViralityScore({ hook: 0, emotion: 50, topic: 0, retention: 50, titleability: 100 }),
      30,
    );
  });

  it('子分被钳制在 0-100', () => {
    const score = computeViralityScore({ hook: 999, emotion: -5, topic: 50, retention: 50, titleability: 50 });
    assert.ok(score >= 0 && score <= 100);
  });
});

describe('parseViralityReports', () => {
  it('解析 markdown 围栏包裹的 JSON 数组', () => {
    const raw = '```json\n[{"index":1,"sub":{"hook":90,"emotion":80,"topic":95,"retention":85,"titleability":88},"reasons":["前3秒有冲突"],"suggestions":["压缩到25秒内"],"titles":["标题A"],"tags":["#影视"],"coverText":["封面字"]},\n{"index":2,"sub":{"hook":60,"emotion":60,"topic":60,"retention":60,"titleability":60},"reasons":["节奏平稳"],"suggestions":[],"titles":[],"tags":[],"coverText":[]}]\n```';
    const reports = parseViralityReports(raw);
    assert.equal(Object.keys(reports).length, 2);
    assert.equal(reports[1].source, 'llm');
    // 0.25*90+0.2*80+0.25*95+0.2*85+0.1*88 = 88.05 → 88
    assert.equal(reports[1].score, 88);
    assert.equal(reports[1].grade, 'S');
    assert.equal(reports[1].sub.hook, 90);
    assert.deepEqual(reports[1].reasons, ['前3秒有冲突']);
    assert.equal(reports[2].grade, 'B');
  });

  it('sub 缺失但 score 合法时五维子分统一取 score', () => {
    const raw = '[{"index":2,"score":80}]';
    const reports = parseViralityReports(raw);
    assert.equal(reports[2].score, 80);
    assert.equal(reports[2].grade, 'A');
    assert.equal(reports[2].sub.hook, 80);
    assert.equal(reports[2].source, 'llm');
  });

  it('index 非法或 score/sub 均缺失的条目被跳过(失败隔离)', () => {
    const raw = '[{"index":0,"score":90},{"index":"x","score":90},{"index":3},{"index":4,"sub":{"hook":1}},{"index":5,"score":70,"reasons":["ok"]}]';
    const reports = parseViralityReports(raw);
    assert.deepEqual(Object.keys(reports), ['5']);
    assert.equal(reports[5].score, 70);
  });

  it('数组条目被过滤为非空字符串并截断到上限', () => {
    const raw = '[{"index":1,"score":90,"titles":["a","","b"],"tags":["#1","#2","#3","#4","#5","#6","#7","#8","#9","#10"]}]';
    const reports = parseViralityReports(raw);
    assert.deepEqual(reports[1].titles, ['a', 'b']);
    // 最多 8 条标签,非字符串条目被过滤
    assert.equal(reports[1].tags.length, 8);
    assert.equal(reports[1].tags[0], '#1');
  });

  it('纯文本/非法 JSON 返回空对象,不抛异常', () => {
    assert.deepEqual(parseViralityReports(''), {});
    assert.deepEqual(parseViralityReports('抱歉,我无法解析'), {});
    assert.deepEqual(parseViralityReports('{"broken":'), {});
  });

  it('兼容单对象返回(无数组包裹)', () => {
    const raw = '{"index":1,"score":90,"reasons":["r"]}';
    const reports = parseViralityReports(raw);
    assert.equal(reports[1].score, 90);
    assert.equal(reports[1].grade, 'S');
  });
});
