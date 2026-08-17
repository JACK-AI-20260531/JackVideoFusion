/**
 * 节奏统计纯函数单测
 * 职责:验证 computeRhythmStats 的镜头均值/剪辑点数计算与空输入兜底
 *      不依赖 electron/shotDetectService,可独立单元测试
 * 运行:npm run test 或 node --test --import tsx src/main/services/film-dub-clone/__tests__/rhythm-stats.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRhythmStats } from '../rhythm-stats.ts';
import type { Shot } from '../shot-detect';

/** 构造一条镜头 */
function shot(duration: number): Shot {
  return { index: 0, startTime: 0, endTime: duration, duration };
}

describe('computeRhythmStats', () => {
  it('计算镜头总数与平均时长', () => {
    const stats = computeRhythmStats([shot(2), shot(4), shot(6)]);
    assert.equal(stats.shotCount, 3);
    assert.equal(stats.avgShotDuration, 4);
  });

  it('剪辑点数 = 镜头数 - 1,N 个镜头间有 N-1 个切换点', () => {
    const stats = computeRhythmStats([shot(1), shot(1), shot(1)]);
    assert.equal(stats.cutCount, 2);
  });

  it('单镜头时剪辑点数为 0', () => {
    const stats = computeRhythmStats([shot(5)]);
    assert.equal(stats.shotCount, 1);
    assert.equal(stats.cutCount, 0);
    assert.equal(stats.avgShotDuration, 5);
  });

  it('无镜头时统计量全部为 0(不抛错)', () => {
    const stats = computeRhythmStats([]);
    assert.deepEqual(stats, { shotCount: 0, avgShotDuration: 0, cutCount: 0 });
  });
});
