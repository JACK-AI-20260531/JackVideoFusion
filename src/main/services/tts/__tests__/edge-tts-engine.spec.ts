/**
 * EdgeTtsEngine 纯函数测试
 * 职责:验证 classifyTtsError 错误分类与 estimateMp3DurationSec 时长估算
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTtsError, estimateMp3DurationSec } from '../edge-tts-engine.ts';

describe('classifyTtsError', () => {
  it('网络错误关键字分类为 network', () => {
    for (const msg of [
      'connect ECONNRESET',
      'etimedout 10.0.0.1',
      'getaddrinfo ENOTFOUND',
      'EAI_AGAIN name lookup failed',
      'WebSocket closed unexpectedly',
      'connection refused (connect)',
      'network unreachable',
      '网络连接失败',
    ]) {
      assert.equal(classifyTtsError(new Error(msg)).category, 'network', `应分类为 network: ${msg}`);
    }
  });

  it('字符/SSML 相关错误分类为 character', () => {
    for (const msg of [
      'SSML parse error',
      'invalid character in input',
      'contains disallowed characters',
      '文本包含非法字符',
      'message too long',
    ]) {
      assert.equal(classifyTtsError(new Error(msg)).category, 'character', `应分类为 character: ${msg}`);
    }
  });

  it('其他错误分类为 engine', () => {
    for (const msg of ['timeout after 5s', 'unknown sdk error', 'internal failure']) {
      assert.equal(classifyTtsError(new Error(msg)).category, 'engine', `应分类为 engine: ${msg}`);
    }
  });

  it('非 Error 入参按字符串处理', () => {
    assert.equal(classifyTtsError('ECONNRESET').category, 'network');
    assert.equal(classifyTtsError(null).category, 'engine');
    assert.equal(classifyTtsError(undefined).category, 'engine');
  });

  it('保留原始错误消息', () => {
    const e = classifyTtsError(new Error('WebSocket failed'));
    assert.equal(e.message, 'WebSocket failed');
    assert.equal(e.category, 'network');
  });
});

describe('estimateMp3DurationSec', () => {
  it('空 Buffer 返回 0', () => {
    assert.equal(estimateMp3DurationSec(Buffer.alloc(0)), 0);
  });

  it('null/undefined 返回 0', () => {
    assert.equal(estimateMp3DurationSec(null as any), 0);
    assert.equal(estimateMp3DurationSec(undefined as any), 0);
  });

  it('按 48kbps 换算字节数为秒数(6000 B/s)', () => {
    // 60 秒 = 6000 * 60 = 360000 字节
    assert.equal(estimateMp3DurationSec(Buffer.alloc(360000)), 60);
    // 1 秒 = 6000 字节
    assert.equal(estimateMp3DurationSec(Buffer.alloc(6000)), 1);
  });

  it('非整秒返回浮点', () => {
    const sec = estimateMp3DurationSec(Buffer.alloc(3000));
    assert.equal(sec, 0.5);
  });
});
