/**
 * OCR 字幕提取流程单测
 * 职责:通过注入 mock ffmpeg 与 mock OCR 引擎,验证 extractSubtitleOcr 的组装编排
 *      (探测→抽帧→逐帧识别→合并→写SRT)及各异常分支
 * 说明:不依赖真实 ffmpeg/Tesseract,输出到临时目录再清理
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/extract.spec.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractSubtitleOcr, type OcrDeps, frameTimeSec } from '../index.ts';
import type { OcrEngine } from '../engine.ts';
import type { OcrRequest } from '../types.ts';
import { CancelToken } from '../../ffmpeg/types';

let tempDir = '';

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jvf-ocr-'));
});
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 构造可配置的 mock OCR 引擎 */
function makeMockEngine(
  texts: string[],
  recognized: string[] = [],
): OcrEngine & { terminated: boolean } {
  let ready = false;
  const mock: OcrEngine & { terminated: boolean } = {
    terminated: false,
    async ensureReady() {
      ready = true;
    },
    async recognize(path: string) {
      if (!ready) throw new Error('未就绪');
      const idx = recognized.length;
      recognized.push(path);
      return texts[idx] ?? '';
    },
    async terminate() {
      mock.terminated = true;
      ready = false;
    },
  };
  return mock;
}

/** 构造 OCR 请求与 mock deps */
function setup(
  over: {
    duration?: number;
    frames?: string[];
    texts?: string[];
    canceled?: boolean;
  } = {},
) {
  const duration = over.duration ?? 10;
  const frames = over.frames ?? ['/tmp/ocr_0001.png', '/tmp/ocr_0002.png'];
  const texts = over.texts ?? ['你好世界', '你好世界'];
  const recognized: string[] = [];
  const engine = makeMockEngine(texts, recognized);
  const ffmpeg = {
    probe: async () => ({ durationSec: duration, filePath: '/v.mp4' }),
    extractFrames: async () => frames,
  } as never;

  const deps: OcrDeps = {
    ffmpeg,
    createEngine: () => engine,
    ensureLang: async () => '/langs',
  };

  const token = new CancelToken('t');
  if (over.canceled) token.cancel('取消');

  let lastProgress = -1;
  const request: OcrRequest = {
    params: {
      videoPath: '/v.mp4',
      outputPath: join(tempDir, 'out.srt'),
      intervalSec: 1,
      minDurationSec: 0.5,
      similarityThreshold: 0.8,
    },
    token: over.canceled ? token : undefined,
    onProgress: (p) => {
      lastProgress = p;
    },
  };
  return { deps, request, engine, recognized, getProgress: () => lastProgress };
}

describe('extractSubtitleOcr 成功流程', () => {
  it('生成 SRT 文件并返回路径', async () => {
    const out = join(tempDir, 'success.srt');
    const { deps } = setup();
    const req: OcrRequest = {
      params: { videoPath: '/v.mp4', outputPath: out, intervalSec: 1, minDurationSec: 0.5, similarityThreshold: 0.8 },
    };
    const path = await extractSubtitleOcr(req, deps);
    assert.equal(path, out);
    assert.equal(existsSync(out), true);
    const content = readFileSync(out, 'utf8');
    assert.ok(content.includes('你好世界'), 'SRT 应包含识别的文本');
  });

  it('回调到最终进度 1', async () => {
    const out = join(tempDir, 'progress.srt');
    const { deps, request, getProgress } = setup();
    request.params.outputPath = out;
    await extractSubtitleOcr(request, deps);
    assert.equal(getProgress(), 1);
  });

  it('完成后清理临时目录并释放引擎', async () => {
    const out = join(tempDir, 'cleanup.srt');
    const { deps, engine, request } = setup();
    request.params.outputPath = out;
    await extractSubtitleOcr(request, deps);
    assert.equal(engine.terminated, true);
  });
});

describe('extractSubtitleOcr 异常分支', () => {
  it('时长 <= 0 时抛错', async () => {
    const { deps, request } = setup({ duration: 0 });
    await assert.rejects(() => extractSubtitleOcr(request, deps), /无法读取视频时长/);
  });

  it('未抽取到任何帧时抛错', async () => {
    const { deps, request } = setup({ frames: [] });
    await assert.rejects(() => extractSubtitleOcr(request, deps), /未抽取到任何视频帧/);
  });

  it('未识别到文字时抛错', async () => {
    const { deps, request } = setup({ texts: ['', ''] });
    await assert.rejects(() => extractSubtitleOcr(request, deps), /未识别到画面文字/);
  });

  it('已取消的令牌立即抛取消错误', async () => {
    const { deps, request } = setup({ canceled: true });
    await assert.rejects(() => extractSubtitleOcr(request, deps), /已取消/);
  });
});

describe('frameTimeSec', () => {
  it('第一帧对应第 1 个间隔处', () => {
    assert.equal(frameTimeSec(0, 5), 5);
    assert.equal(frameTimeSec(1, 5), 10);
  });
});
