/**
 * 字幕流提取纯函数单测
 * 职责:验证从 ffprobe 原始返回中提取第一条字幕流及字幕流数量
 * 运行:node --test --experimental-strip-types src/main/services/ffmpeg/__tests__/subtitle-stream.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSubtitleStreams } from '../subtitle-stream.ts';

describe('extractSubtitleStreams', () => {
  it('从 ffprobe 返回中提取字幕流', () => {
    const data = {
      streams: [
        { codec_type: 'video', index: 0 },
        { codec_type: 'subtitle', index: 1, codec_name: 'mov_text' },
      ],
    };
    const result = extractSubtitleStreams(data);
    assert.equal(result.length, 1);
    assert.equal(result[0].codec_name, 'mov_text');
  });

  it('没有字幕流时返回空数组', () => {
    const data = {
      streams: [
        { codec_type: 'video', index: 0 },
        { codec_type: 'audio', index: 1 },
      ],
    };
    assert.equal(extractSubtitleStreams(data).length, 0);
  });

  it('streams 缺失或为空时返回空数组', () => {
    assert.equal(extractSubtitleStreams({}).length, 0);
    assert.equal(extractSubtitleStreams({ streams: [] }).length, 0);
  });

  it('多个字幕流时全部提取', () => {
    const data = {
      streams: [
        { codec_type: 'video', index: 0 },
        { codec_type: 'subtitle', index: 1, codec_name: 'mov_text' },
        { codec_type: 'audio', index: 2 },
        { codec_type: 'subtitle', index: 3, codec_name: 'subrip' },
      ],
    };
    const result = extractSubtitleStreams(data);
    assert.equal(result.length, 2);
    assert.deepEqual(result, [
      { index: 1, codec_name: 'mov_text', language: undefined },
      { index: 3, codec_name: 'subrip', language: undefined },
    ]);
  });

  it('index 缺失时兜底为 -1,codec_name/language 非 string 时置 undefined', () => {
    const data = {
      streams: [
        { codec_type: 'subtitle' },
        { codec_type: 'subtitle', index: 'x', codec_name: 123, language: 456 },
      ],
    };
    const result = extractSubtitleStreams(data);
    assert.deepEqual(result, [
      { index: -1, codec_name: undefined, language: undefined },
      { index: -1, codec_name: undefined, language: undefined },
    ]);
  });

  it('streams 为合法 string language 时保留 language', () => {
    const data = {
      streams: [{ codec_type: 'subtitle', index: 0, codec_name: 'mov_text', language: 'chi' }],
    };
    const result = extractSubtitleStreams(data);
    assert.equal(result[0].language, 'chi');
  });

  it('非对象数据或 streams 非数组时返回空数组', () => {
    assert.equal(extractSubtitleStreams(null).length, 0);
    assert.equal(extractSubtitleStreams(undefined).length, 0);
    assert.equal(extractSubtitleStreams('str').length, 0);
    assert.equal(extractSubtitleStreams({ streams: 'not-array' }).length, 0);
  });
});
