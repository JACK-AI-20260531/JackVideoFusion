/**
 * CLIP 服务工厂降级决策单测
 * 职责:通过注入 mock 的 onnx 加载与引擎构造,确定性验证 resolveClipEngine
 *      的 ONNX 命中与 Mock 降级逻辑(不触发网络/ native 加载)
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/factory.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClipEngine, type ClipEngineResolverDeps } from '../factory.ts';
import { MockClipEngine } from '../mock-engine.ts';
import type { IClipService } from '../types';

/** 一个可区分的假 ONNX 引擎 */
function fakeEngine(): IClipService {
  return {
    isRealModel: true,
    async loadModel() { return undefined; },
    async embedText(t) { return new Float32Array([t.length, 0]); },
    async embedImage(p) { return new Float32Array([p.length, 0]); },
    async embedVideoFrame() { return new Float32Array([1, 0]); },
    cosineSimilarity() { return 0.5; },
    async match() { return []; },
  };
}

describe('resolveClipEngine', () => {
  it('onnx 加载成功且引擎构造成功时返回真实引擎', async () => {
    const real = fakeEngine();
    const deps: ClipEngineResolverDeps = {
      loadOnnx: async () => ({ fake: true }),
      createEngine: async () => real,
    };
    const engine = await resolveClipEngine(deps);
    assert.equal(engine.isRealModel, true);
    assert.equal(engine, real);
  });

  it('onnx 加载成功但引擎构造返回 null 时降级为 Mock', async () => {
    const deps: ClipEngineResolverDeps = {
      loadOnnx: async () => ({}),
      createEngine: async () => null,
    };
    const engine = await resolveClipEngine(deps);
    assert.ok(engine instanceof MockClipEngine);
    assert.equal(engine.isRealModel, false);
  });

  it('onnx 加载失败(native 不可用)时降级为 Mock', async () => {
    const deps: ClipEngineResolverDeps = {
      loadOnnx: async () => {
        throw new Error('cannot load native binding');
      },
    };
    const engine = await resolveClipEngine(deps);
    assert.ok(engine instanceof MockClipEngine);
  });

  it('引擎构造抛错时降级为 Mock', async () => {
    const deps: ClipEngineResolverDeps = {
      loadOnnx: async () => ({}),
      createEngine: async () => {
        throw new Error('model missing');
      },
    };
    const engine = await resolveClipEngine(deps);
    assert.ok(engine instanceof MockClipEngine);
  });
});
