/**
 * 对话式编辑计划单测(PRD-文本即时间线 v2.0 M4 / FR-4)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditPlanPrompt,
  parseEditPlan,
  sanitizeEditPlan,
} from '../edit-plan';
import { TextTimelineService } from '../service';
import type { AsrEngine } from '../../asr/engine';

describe('parseEditPlan', () => {
  it('剥离 markdown 围栏后解析 ops', () => {
    const raw = '```json\n{"ops":[{"op":"cut","start":1,"end":2,"reason":"r"}]}\n```';
    const parsed = parseEditPlan(raw);
    assert.equal(parsed.ops?.length, 1);
    assert.equal(parsed.ops?.[0].op, 'cut');
  });

  it('纯 JSON 直解', () => {
    const parsed = parseEditPlan('{"ops":[{"op":"mute","start":0,"end":1}]}');
    assert.equal(parsed.ops?.length, 1);
  });

  it('澄清反问路径', () => {
    const parsed = parseEditPlan('{"clarification":"请问要删掉哪一段?"}');
    assert.equal(parsed.clarification, '请问要删掉哪一段?');
  });

  it('垃圾输出 → parseError', () => {
    const parsed = parseEditPlan('抱歉我不知道');
    assert.ok(parsed.parseError);
    assert.equal(parsed.ops, undefined);
  });
});

describe('sanitizeEditPlan', () => {
  const segments = [
    { id: 'seg-1', text: 'A', start: 0, end: 2 },
    { id: 'seg-2', text: 'B', start: 5, end: 8 },
  ];

  it('segId 引用自动展开为段落区间', () => {
    const ops = sanitizeEditPlan(
      [{ op: 'cut', start: NaN, end: NaN, reason: 'x', segId: 'seg-2' } as never],
      segments,
      100,
    );
    assert.equal(ops.length, 1);
    assert.equal(ops[0].start, 5);
    assert.equal(ops[0].end, 8);
  });

  it('越界区间钳制到素材时长,倒置丢弃', () => {
    const ops = sanitizeEditPlan(
      [
        { op: 'cut', start: 95, end: 200 },
        { op: 'cut', start: 50, end: 40 },
        { op: 'cut', start: 150, end: 160 },
      ],
      segments,
      100,
    );
    assert.equal(ops.length, 1);
    assert.equal(ops[0].end, 100);
  });

  it('move 越界/倒置丢弃,retune 字段校验', () => {
    const ops = sanitizeEditPlan(
      [
        { op: 'move', srcStart: 0, srcEnd: -5, dstIndex: 0 },
        { op: 'move', srcStart: 0, srcEnd: 5, dstIndex: -3 },
        { op: 'retune', param: '', value: 'x' },
        { op: 'retune', param: 'volume', value: '80' },
      ] as never,
      segments,
      100,
    );
    assert.equal(ops.length, 2);
    assert.equal((ops[0] as { dstIndex: number }).dstIndex, 0);
  });
});

describe('TextTimelineService.planEdits/applyPlan', () => {
  function makeService(llmContent: string): TextTimelineService {
    return new TextTimelineService({
      probeDurationSec: async () => 100,
      ensureModelDir: () => '/tmp/asr-cache',
      genSessionId: () => 'tt-test',
      createAsrEngine: () =>
        ({
          ensureReady: async () => {},
          transcribe: async () =>
            [
              { startSec: 0, endSec: 2, text: '第一句' },
              { startSec: 5, endSec: 8, text: '第二段内容' },
            ],
          terminate: async () => {},
        }) as unknown as AsrEngine,
      llmChat: async () => ({ content: llmContent }),
    });
  }

  it('指令 → 计划 → 应用(部分勾选)', async () => {
    const svc = makeService('{"ops":[{"op":"cut","segId":"seg-2","reason":"删第二句"}]}');
    const snap = await svc.prepare('C:/v.mp4');
    const plan = await svc.planEdits(snap.sessionId, '删掉第二句');
    if (!('ops' in plan)) throw new Error('应返回计划');
    assert.equal(plan.ops.length, 1);
    // 只勾选第 0 条
    const after = svc.applyPlan(snap.sessionId, plan.planId, [0]);
    assert.equal(after.totalSec, 97);
    assert.equal(after.segments.find((s) => s.text === '第二段内容')?.deleted, true);
  });

  it('LLM 返回澄清 → 不生成计划', async () => {
    const svc = makeService('{"clarification":"要删哪一段?"}');
    const snap = await svc.prepare('C:/v.mp4');
    const result = await svc.planEdits(snap.sessionId, '随便剪剪');
    if (!('clarification' in result)) throw new Error('应返回澄清');
    assert.ok(result.clarification.includes('哪一段'));
    // 不存在的 planId 抛错(空计划路径不产生变更)
    assert.throws(() => svc.applyPlan(snap.sessionId, 'nope'), /编辑计划不存在/);
  });

  it('不存在的 planId 抛错', async () => {
    const svc = makeService('{"ops":[{"op":"cut","start":0,"end":1}]}');
    const snap = await svc.prepare('C:/v.mp4');
    assert.throws(() => svc.applyPlan(snap.sessionId, 'nope'), /编辑计划不存在/);
  });
});
