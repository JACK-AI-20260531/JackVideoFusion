/**
 * 语音克隆服务纯逻辑单测
 * 职责:验证 estimateWavDurationSec(wav 时长估算)、mapCloneLanguageToEdgeVoice(语言→音色映射)、
 *      concatWavBuffers(wav 合并)
 * 说明:这些均为纯 Buffer/字符串计算;类方法依赖 HTTP/GPT-SoVITS 服务,不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/voice-clone/__tests__/index.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateWavDurationSec } from '../gpt-sovits-client.ts';
import { mapCloneLanguageToEdgeVoice, concatWavBuffers } from '../voice-clone-service.ts';

/**
 * 构造一个最小合法 wav 头(44 字节),写入指定 byteRate 与数据长度
 * @param byteRate 字节率(偏移 28)
 * @param dataBytes 除 44 字节头外的数据长度
 */
function makeWav(byteRate: number, dataBytes: number): Buffer {
  const buf = Buffer.alloc(44 + dataBytes);
  // RIFF size(偏移 4)= 36 + dataBytes
  buf.writeUInt32LE(36 + dataBytes, 4);
  // 模拟 fmt 头长度(偏移 16)= 16
  buf.writeUInt32LE(16, 16);
  // 字节率(偏移 28)
  buf.writeUInt32LE(byteRate, 28);
  return buf;
}

describe('estimateWavDurationSec', () => {
  it('不足 44 字节(非完整 wav 头)返回 0', () => {
    assert.equal(estimateWavDurationSec(Buffer.alloc(10)), 0);
    assert.equal(estimateWavDurationSec(Buffer.alloc(0)), 0);
    assert.equal(estimateWavDurationSec(null as never), 0);
  });

  it('按 dataBytes / byteRate 计算时长', () => {
    // 16kHz 16bit mono => byteRate = 32000
    const wav = makeWav(32000, 64000); // 2 秒
    assert.equal(estimateWavDurationSec(wav), 2);
  });

  it('byteRate 为 0 时返回 0(避免除零)', () => {
    const wav = makeWav(0, 64000);
    assert.equal(estimateWavDurationSec(wav), 0);
  });

  it('纯头部(无数据)返回 0', () => {
    const wav = makeWav(32000, 0);
    assert.equal(estimateWavDurationSec(wav), 0);
  });
});

describe('mapCloneLanguageToEdgeVoice', () => {
  it('各语言映射到对应 Edge-TTS 音色', () => {
    assert.equal(mapCloneLanguageToEdgeVoice('zh'), 'zh-CN-XiaoxiaoNeural');
    assert.equal(mapCloneLanguageToEdgeVoice('en'), 'en-US-AriaNeural');
    assert.equal(mapCloneLanguageToEdgeVoice('jp'), 'ja-JP-NanamiNeural');
    assert.equal(mapCloneLanguageToEdgeVoice('kr'), 'ko-KR-SunHiNeural');
    assert.equal(mapCloneLanguageToEdgeVoice('auto'), 'zh-CN-XiaoxiaoNeural');
  });
});

describe('concatWavBuffers', () => {
  it('空数组返回空 Buffer', () => {
    assert.equal(concatWavBuffers([]).length, 0);
  });

  it('单元素直接返回该 Buffer', () => {
    const single = makeWav(32000, 100);
    assert.equal(concatWavBuffers([single]), single);
  });

  it('多段合并:header 复用首个,data 段拼接并更新 size 字段', () => {
    const b1 = makeWav(32000, 100);
    const b2 = makeWav(32000, 50);
    const merged = concatWavBuffers([b1, b2]);
    // 44 header + 100 + 50 data
    assert.equal(merged.length, 44 + 150);
    // data chunk size(偏移 40)= 150
    assert.equal(merged.readUInt32LE(40), 150);
    // RIFF size(偏移 4)= 36 + 150
    assert.equal(merged.readUInt32LE(4), 36 + 150);
    // WAVE 魔数与 fmt 段标记从头一个 wav 保留
    assert.deepEqual(merged.slice(8, 28), b1.slice(8, 28));
    // data 顺序正确:b1 的 data 在前,b2 的 data 在后
    assert.deepEqual(merged.slice(44, 44 + 100), b1.slice(44));
    assert.deepEqual(merged.slice(144, 194), b2.slice(44));
  });

  it('跳过不足 44 字节的非法 wav(只合并合法段)', () => {
    const good = makeWav(32000, 50);
    const bad = Buffer.alloc(10);
    const merged = concatWavBuffers([good, bad]);
    assert.equal(merged.length, 44 + 50);
    assert.equal(merged.readUInt32LE(40), 50);
  });
});
