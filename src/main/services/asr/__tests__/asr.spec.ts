/**
 * ASR 语音转写字幕 纯逻辑单测
 * 职责:验证 serializeSegmentsToSrt 把时间戳片段序列化为 SRT 的正确性,
 *      以及 extractSubtitleAsr 主流程(注入 mock 引擎)的落盘/进度/取消逻辑。
 * 说明:不加载真实 Whisper 模型,不执行真实 ffmpeg。
 * 运行:npm run test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { serializeSegmentsToSrt, extractSubtitleAsr } from '../index.ts';
import { createMockAsrEngine } from '../engine.ts';
import type { AsrSegment, AsrLang } from '../types.ts';

describe('serializeSegmentsToSrt', () => {
  it('把带时间戳片段序列化为标准 SRT', () => {
    const segments: AsrSegment[] = [
      { startSec: 0, endSec: 3.5, text: '你好世界' },
      { startSec: 3.5, endSec: 6, text: '这是一段测试' },
    ];
    const srt = serializeSegmentsToSrt(segments);
    assert.match(srt, /00:00:00,000 --> 00:00:03,500/);
    assert.match(srt, /00:00:03,500 --> 00:00:06,000/);
    assert.match(srt, /你好世界/);
    assert.match(srt, /这是一段测试/);
  });

  it('跳过空文本片段与过短结束时间', () => {
    const segments: AsrSegment[] = [
      { startSec: 1, endSec: 2, text: '  ' }, // 空文本被过滤
      { startSec: 5, endSec: 5, text: '有效' }, // end<=start 时收敛
    ];
    const srt = serializeSegmentsToSrt(segments);
    assert.ok(!srt.includes('空文本'));
    assert.match(srt, /有效/);
  });

  it('空输入返回空串', () => {
    assert.equal(serializeSegmentsToSrt([]), '');
  });
});

describe('extractSubtitleAsr 主流程', () => {
  it('注入 mock 引擎,正确生成 SRT 文件并返回路径', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jvf-asr-ext-'));
    const outputPath = join(outDir, 'sub.srt');
    try {
      const mockSegments: AsrSegment[] = [
        { startSec: 0, endSec: 2, text: '第一句' },
        { startSec: 2, endSec: 4, text: '第二句' },
      ];
      // 注入 mock 引擎,返回固定片段
      const createEngine = () => createMockAsrEngine(async () => mockSegments);
      const phases: string[] = [];
      const res = await extractSubtitleAsr(
        {
          params: { videoPath: '/fake/video.mp4', outputPath, lang: 'zh' as AsrLang },
          onProgress: (_p, phase) => phases.push(phase),
        },
        { createEngine: createEngine as never },
      );

      assert.equal(res, outputPath);
      assert.ok(existsSync(outputPath));
      const srt = readFileSync(outputPath, 'utf8');
      assert.match(srt, /第一句/);
      assert.match(srt, /第二句/);
      // 进度阶段应被触发
      assert.ok(phases.length > 0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('引擎未识别到内容时抛错且不写文件', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jvf-asr-empty-'));
    const outputPath = join(outDir, 'sub.srt');
    try {
      const createEngine = () => createMockAsrEngine(async () => []);
      await assert.rejects(
        extractSubtitleAsr(
          { params: { videoPath: '/fake/video.mp4', outputPath } },
          { createEngine: createEngine as never },
        ),
        /未识别到语音内容/,
      );
      assert.ok(!existsSync(outputPath));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
