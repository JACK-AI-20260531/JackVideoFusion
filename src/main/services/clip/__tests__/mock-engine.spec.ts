/**
 * CLIP Mock 引擎单测
 * 职责:验证 MockClipEngine 各方法(embedText/embedImage/embedVideoFrame/cosineSimilarity/match)
 *      的确定性与相似度区分度
 * 说明:嵌入算法本身在 embedding.spec.ts 已测,此处验证 Mock 引擎的接口行为与 match 排序
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/mock-engine.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockClipEngine } from '../mock-engine.ts';
import type { MatchCandidate } from '../types.ts';

describe('MockClipEngine', () => {
  const engine = new MockClipEngine();

  it('isRealModel 恒为 false', () => {
    assert.equal(engine.isRealModel, false);
  });

  it('loadModel 可正常完成(空操作)', async () => {
    await engine.loadModel();
    assert.ok(true);
  });

  it('embedText 相同输入产生完全相同向量(确定性)', async () => {
    const a = await engine.embedText('你好世界');
    const b = await engine.embedText('你好世界');
    assert.equal(a.length, 512);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it('embedText 不同输入产生不同向量(有区分度)', async () => {
    const a = await engine.embedText('晴天');
    const b = await engine.embedText('下雨');
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });

  it('embedText 空文本与 null 不抛错且返回合法向量', async () => {
    const empty = await engine.embedText('');
    const none = await engine.embedText(null as never);
    assert.equal(empty.length, 512);
    assert.equal(none.length, 512);
  });

  it('embedImage 基于路径生成确定性向量', async () => {
    const a = await engine.embedImage('/img/a.jpg');
    const b = await engine.embedImage('/img/a.jpg');
    const c = await engine.embedImage('/img/b.jpg');
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.notDeepEqual(Array.from(a), Array.from(c));
  });

  it('embedVideoFrame 基于路径+时间戳生成确定性向量', async () => {
    const a = await engine.embedVideoFrame('/v/1.mp4', 5);
    const b = await engine.embedVideoFrame('/v/1.mp4', 5);
    const c = await engine.embedVideoFrame('/v/1.mp4', 6);
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.notDeepEqual(Array.from(a), Array.from(c));
  });

  it('embedVideoFrame 非法时间戳归一为 0', async () => {
    const a = await engine.embedVideoFrame('/v/1.mp4', Number.NaN);
    const b = await engine.embedVideoFrame('/v/1.mp4', 0);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it('cosineSimilarity 相同向量为 1', () => {
    const v = new Float32Array(512);
    v[0] = 1;
    assert.equal(engine.cosineSimilarity(v, v), 1);
  });

  it('match 按相似度降序返回', async () => {
    const textVec = await engine.embedText('猫');
    const candidates: MatchCandidate[] = [
      { id: 'low', embedding: await engine.embedText('汽车') },
      { id: 'high', embedding: textVec },
      { id: 'mid', embedding: await engine.embedText('猫爪') },
    ];
    const results = await engine.match('猫', candidates);
    assert.equal(results.length, 3);
    // 完全相同的文本向量相似度最高
    assert.equal(results[0].id, 'high');
    // 分数在 [-1,1] 区间
    for (const r of results) {
      assert.ok(r.score >= -1 && r.score <= 1);
    }
    // 降序
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });

  it('match 空候选返回空数组', async () => {
    const results = await engine.match('x', []);
    assert.deepEqual(results, []);
  });
});
