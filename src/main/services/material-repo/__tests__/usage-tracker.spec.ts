/**
 * 素材使用计数与防撞车单测(PRD-v1.7 FR-5)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker, filterRecentUsage, REUSE_WINDOW_MS } from '../usage-tracker';

/** 内存版构造 */
function makeTracker(initial: Record<string, { count: number; lastUsedAt: string }> = {}) {
  let store = { ...initial };
  const persisted: Record<string, { count: number; lastUsedAt: string }>[] = [];
  const tracker = new UsageTracker({
    load: () => ({ ...store }),
    persist: (record) => {
      store = { ...record };
      persisted.push({ ...record });
    },
  });
  return { tracker, persisted, getStore: () => store };
}

describe('UsageTracker.record', () => {
  it('同批重复路径只计一次', () => {
    const { tracker, getStore } = makeTracker();
    tracker.record(['a.mp4', 'a.mp4', 'b.mp4'], new Date('2026-09-01T00:00:00Z'));
    const store = getStore();
    assert.equal(store['a.mp4'].count, 1);
    assert.equal(store['b.mp4'].count, 1);
  });

  it('重复记录累加计数', () => {
    const { tracker, getStore } = makeTracker();
    tracker.record(['a.mp4'], new Date('2026-09-01T00:00:00Z'));
    tracker.record(['a.mp4'], new Date('2026-09-02T00:00:00Z'));
    assert.equal(getStore()['a.mp4'].count, 2);
    assert.equal(getStore()['a.mp4'].lastUsedAt, '2026-09-02T00:00:00.000Z');
  });

  it('较早时间不覆盖较新的最近使用时间', () => {
    const { tracker, getStore } = makeTracker();
    tracker.record(['a.mp4'], new Date('2026-09-05T00:00:00Z'));
    tracker.record(['a.mp4'], new Date('2026-09-01T00:00:00Z'));
    assert.equal(getStore()['a.mp4'].lastUsedAt, '2026-09-05T00:00:00.000Z');
  });

  it('每次变更即落盘', () => {
    const { tracker, persisted } = makeTracker();
    tracker.record(['a.mp4'], new Date());
    tracker.record(['b.mp4'], new Date());
    assert.equal(persisted.length, 2);
  });
});

describe('UsageTracker.isRecentlyUsed', () => {
  it('窗口内 → true,窗口外 → false', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const { tracker } = makeTracker({
      'recent.mp4': { count: 1, lastUsedAt: '2026-08-31T00:00:00.000Z' }, // 1 天前
      'old.mp4': { count: 1, lastUsedAt: '2026-08-01T00:00:00.000Z' }, // 31 天前
    });
    assert.equal(tracker.isRecentlyUsed('recent.mp4', now, REUSE_WINDOW_MS), true);
    assert.equal(tracker.isRecentlyUsed('old.mp4', now, REUSE_WINDOW_MS), false);
    assert.equal(tracker.isRecentlyUsed('missing.mp4', now, REUSE_WINDOW_MS), false);
  });
});

describe('filterRecentUsage', () => {
  it('按窗口拆分保留/警告列表(纯函数)', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const usage = {
      'recent.mp4': { count: 1, lastUsedAt: '2026-08-31T00:00:00.000Z' },
      'old.mp4': { count: 3, lastUsedAt: '2026-08-01T00:00:00.000Z' },
    };
    const { kept, warned } = filterRecentUsage(['recent.mp4', 'old.mp4', 'new.mp4'], usage, now);
    assert.deepEqual(kept.sort(), ['new.mp4', 'old.mp4']);
    assert.deepEqual(warned, ['recent.mp4']);
  });
});
