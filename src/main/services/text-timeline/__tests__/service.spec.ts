/**
 * 文本即时间线会话编排单测(PRD-文本即时间线 v2.0 M2)
 * ASR/时长探测全部依赖注入,不触达真实引擎
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TextTimelineService,
  asrToTextSegments,
  isSegmentDeleted,
} from '../service';
import type { AsrEngine } from '../../asr/engine';
import type { AsrSegment } from '../../asr/types';
import { createEdl, applyCut } from '../edl';

/** 预置会话(时长 100s,3 句) */
function makeService(): TextTimelineService {
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
            { startSec: 2, endSec: 4, text: '嗯。' },
            { startSec: 5, endSec: 8, text: '第二段内容' },
          ] as AsrSegment[],
        terminate: async () => {},
      }) as unknown as AsrEngine,
  });
}

describe('asrToTextSegments', () => {
  it('过滤空文本、按时间升序、分配 seg-N 标识', () => {
    const segs = asrToTextSegments([
      { startSec: 5, endSec: 6, text: 'B句' },
      { startSec: 0, endSec: 2, text: 'A句' },
      { startSec: 7, endSec: 8, text: '   ' },
    ]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].id, 'seg-1');
    assert.equal(segs[0].text, 'A句');
    assert.equal(segs[1].text, 'B句');
    assert.equal(segs[1].start, 5);
  });
});

describe('TextTimelineService.prepare', () => {
  it('创建会话:返回段落与初始 EDL,无删除标记', async () => {
    const svc = makeService();
    const snap = await svc.prepare('C:/video/a.mp4');
    assert.equal(snap.videoPath, 'C:/video/a.mp4');
    assert.equal(snap.durationSec, 100);
    assert.equal(snap.segments.length, 3);
    assert.equal(snap.segments[0].deleted, false);
    assert.equal(snap.totalSec, 100);
    assert.equal(snap.canUndo, false);
  });

  it('缺少路径抛错', async () => {
    const svc = makeService();
    await assert.rejects(() => svc.prepare(''), /缺少视频文件路径/);
  });
});

describe('applyOps/undo/redo', () => {
  it('删除句 → 段落划线 + 总时长缩短,可撤销', async () => {
    const svc = makeService();
    const snap = await svc.prepare('C:/video/a.mp4');
    // 删除 [5, 8) 的"第二段内容"
    const after = svc.applyOps(snap.sessionId, [{ op: 'cut', start: 5, end: 8, reason: '删句' }]);
    const deletedSeg = after.segments.find((s) => s.text === '第二段内容');
    assert.equal(deletedSeg?.deleted, true);
    assert.equal(after.totalSec, 97);
    assert.equal(after.canUndo, true);

    // 撤销后恢复
    const undone = svc.undo(snap.sessionId);
    assert.equal(undone.totalSec, 100);
    assert.equal(undone.segments.find((s) => s.text === '第二段内容')?.deleted, false);
  });

  it('不存在的会话抛错', async () => {
    const svc = makeService();
    assert.throws(() => svc.applyOps('nope', []), /会话不存在/);
    assert.equal(svc.get('nope'), null);
  });

  it('undo 到初始后 canUndo=false,redo 恢复', async () => {
    const svc = makeService();
    const snap = await svc.prepare('C:/video/a.mp4');
    svc.applyOps(snap.sessionId, [{ op: 'cut', start: 1, end: 2 }]);
    const undone = svc.undo(snap.sessionId);
    assert.equal(undone.canUndo, false);
    assert.equal(undone.canRedo, true);
    const redone = svc.redo(snap.sessionId);
    assert.equal(redone.totalSec, 99);
  });
});

describe('isSegmentDeleted', () => {
  it('重叠 ≤ 50% 判定为已删除', () => {
    const edl = applyCut(createEdl('a.mp4', 100), 0, 90); // 保留 [90,100)
    // 段落 [85,95) 只有 5s 在保留区(50%) → 删除
    assert.equal(isSegmentDeleted(edl, { start: 85, end: 95 }), true);
    // 段落 [92,98) 完整保留 → 未删
    assert.equal(isSegmentDeleted(edl, { start: 92, end: 98 }), false);
  });
});

describe('360p 代理预览', () => {
  function makeProxyService(
    proxy?: (src: string, dest: string) => Promise<void>,
  ): TextTimelineService {
    return new TextTimelineService({
      probeDurationSec: async () => 100,
      ensureModelDir: () => '/tmp/asr-cache',
      genSessionId: () => 'tt-proxy',
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
      generateProxy: proxy,
    });
  }

  it('代理就绪后快照携带 proxyPath/proxyReady', async () => {
    const svc = makeProxyService(async () => {});
    const snap = await svc.prepare('C:/video/a.mp4');
    // prepare 返回时代理仍在后台生成
    assert.equal(snap.proxyReady, false);
    await new Promise((r) => setTimeout(r, 10));
    const after = svc.get('tt-proxy');
    assert.equal(after?.proxyReady, true);
    assert.equal(after?.proxyPath, 'C:/video/a.proxy-360p.mp4');
  });

  it('代理生成失败 → 回退原片,不阻断会话', async () => {
    const svc = makeProxyService(async () => {
      throw new Error('boom');
    });
    await svc.prepare('C:/video/a.mp4');
    await new Promise((r) => setTimeout(r, 10));
    const after = svc.get('tt-proxy');
    assert.equal(after?.proxyReady, false);
    assert.equal(after?.totalSec, 100);
  });
});
