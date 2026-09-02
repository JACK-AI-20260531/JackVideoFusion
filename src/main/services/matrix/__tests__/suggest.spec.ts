/**
 * 内容-分组匹配建议单测(PRD-v2.1 FR-7)
 * 运行:node --test --import tsx src/main/services/matrix/__tests__/suggest.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { suggestGroups, bigramSimilarity } from '../suggest';
import type { AnalyticsRecord } from '../../auto-publish/analytics-store';
import type { MatrixGroup } from '../types';

const GROUPS: MatrixGroup[] = [
  { id: 'g1', name: '剧情号', platforms: ['douyin'], createdAt: 't', updatedAt: 't' },
  { id: 'g2', name: '知识号', platforms: ['bilibili'], createdAt: 't', updatedAt: 't' },
];

/** 构造带标题的记录(互动率 = likes/plays) */
function rec(platform: string, title: string, plays: number, likes: number): AnalyticsRecord {
  return {
    videoUrl: `https://v/${platform}-${title}-${plays}`,
    taskId: `t-${platform}-${title}`,
    platform: platform as never,
    title,
    history: [{ plays, likes, comments: 0, collectedAt: '2026-01-01T00:00:00.000Z' }],
  };
}

describe('bigramSimilarity', () => {
  test('完全相同为 1,无重合为 0,短串为 0', () => {
    assert.equal(bigramSimilarity('剧情反转', '剧情反转'), 1);
    assert.equal(bigramSimilarity('剧情', '产品介绍'), 0);
    assert.equal(bigramSimilarity('a', 'abc'), 0);
  });
});

describe('suggestGroups', () => {
  const records = [
    rec('douyin', '剧情反转短片', 1000, 100),
    rec('bilibili', '知识科普讲解', 2000, 20),
  ];

  test('标题相似度高的分组排前', () => {
    const suggestions = suggestGroups('剧情反转小剧场', records, GROUPS, 3);
    assert.equal(suggestions[0].groupId, 'g1');
    assert.ok(suggestions.length <= 3);
  });

  test('Top-N 截断', () => {
    const suggestions = suggestGroups('完全无关的标题xyz', records, GROUPS, 1);
    assert.equal(suggestions.length, 1);
  });

  test('无历史记录的分组分数为 0,排序靠后', () => {
    const suggestions = suggestGroups('剧情反转', [], GROUPS, 3);
    assert.ok(suggestions.every((s) => s.score === 0));
  });
});
