/**
 * 节奏复刻纯逻辑单测
 * 职责:验证 cloner 模块的 computeClipRange(素材切片安全起点与时长)
 * 说明:纯函数;cloneVideo 主流程依赖 ffmpeg/tts 进程,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/film-dub-clone/__tests__/cloner.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeClipRange, buildShotScriptSrtEntries } from '../cloner.ts';

describe('computeClipRange', () => {
  it('区间完全在素材内时保持起点与期望时长', () => {
    assert.deepEqual(computeClipRange(10, 5, 30), { start: 10, duration: 5 });
  });

  it('目标区间超出素材末尾时前移起点凑足时长', () => {
    // start=28, dur=5 → 28+5=33 > 30,前移到 25
    assert.deepEqual(computeClipRange(28, 5, 30), { start: 25, duration: 5 });
  });

  it('期望时长超过素材总长时取素材全长', () => {
    // desired=50 > mat=20,dur=20,start 保持 0
    assert.deepEqual(computeClipRange(0, 50, 20), { start: 0, duration: 20 });
  });

  it('素材时长为 0/无效时返回期望时长且起点归零保护', () => {
    assert.deepEqual(computeClipRange(5, 3, 0).duration, 3);
    assert.deepEqual(computeClipRange(-2, 3, 0).start, 0);
  });

  it('起点为负时归零', () => {
    assert.deepEqual(computeClipRange(-5, 4, 30), { start: 0, duration: 4 });
  });
});

describe('buildShotScriptSrtEntries', () => {
  it('按镜头时间轴生成条目,序号从 1 连续递增', () => {
    const entries = buildShotScriptSrtEntries([
      { index: 0, text: '第一段', startSec: 0, durationSec: 5 },
      { index: 1, text: '第二段', startSec: 5, durationSec: 4 },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].index, 1);
    assert.equal(entries[1].index, 2);
    assert.equal(entries[0].startTime, '00:00:00,000');
    assert.equal(entries[0].endTime, '00:00:05,000');
    assert.equal(entries[1].startTime, '00:00:05,000');
    assert.equal(entries[1].endTime, '00:00:09,000');
  });

  it('空字幕镜头被跳过,后续序号连续', () => {
    const entries = buildShotScriptSrtEntries([
      { index: 0, text: '有内容', startSec: 0, durationSec: 3 },
      { index: 1, text: '   ', startSec: 3, durationSec: 2 }, // 纯空白,跳过
      { index: 2, text: '结尾', startSec: 5, durationSec: 2 },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].text, '有内容');
    assert.equal(entries[1].text, '结尾');
    assert.equal(entries[1].index, 2);
  });

  it('超短镜头补足最短时长(MIN_CLIP_DURATION_SEC)', () => {
    // durationSec=0.1 < 0.2 → end = start + 0.2
    const entries = buildShotScriptSrtEntries([
      { index: 0, text: '短', startSec: 1, durationSec: 0.1 },
    ]);
    assert.equal(entries[0].startTime, '00:00:01,000');
    assert.equal(entries[0].endTime, '00:00:01,200');
  });
});
