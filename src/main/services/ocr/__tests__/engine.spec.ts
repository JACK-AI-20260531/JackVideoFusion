/**
 * OCR 引擎 Mock 实现单测
 * 职责:验证 createMockOcrEngine 的状态机行为(未就绪抛错、recognize 委托、terminate 复位)
 * 说明:TesseractOcrEngine 依赖真实 tesseract.js worker,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/engine.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockOcrEngine } from '../engine.ts';

describe('createMockOcrEngine', () => {
  it('识别前未 ensureReady 时抛“未就绪”错误', async () => {
    const engine = createMockOcrEngine(async (p) => p);
    await assert.rejects(() => engine.recognize('/a.png'), /未就绪/);
  });

  it('ensureReady 后 recognize 委托给注入的识别函数', async () => {
    const calls: string[] = [];
    const engine = createMockOcrEngine(async (p) => {
      calls.push(p);
      return '识别结果';
    });
    await engine.ensureReady();
    assert.equal(await engine.recognize('/b.png'), '识别结果');
    assert.deepEqual(calls, ['/b.png']);
  });

  it('ensureReady 幂等可重复调用', async () => {
    const engine = createMockOcrEngine(async () => 'x');
    await engine.ensureReady();
    await engine.ensureReady();
    assert.equal(await engine.recognize('/a.png'), 'x');
  });

  it('terminate 后复位,再次识别抛“未就绪”', async () => {
    const engine = createMockOcrEngine(async () => 'x');
    await engine.ensureReady();
    await engine.terminate();
    await assert.rejects(() => engine.recognize('/a.png'), /未就绪/);
  });
});
