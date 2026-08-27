/**
 * CN-CLIP 双塔模型下载器单测
 * 职责:验证模型目录解析、就绪检测(isClipModelReady)、路径辅助函数以及
 *      ensureClipModel 的就绪短路逻辑。
 * 说明:
 *      通过 _setClipModelDirForTest 注入临时目录,绕过 electron app 依赖;
 *      网络下载路径(ensureClipModel 缺失文件时的真实 HTTP 请求)依赖外部
 *      ModelScope 服务,不适合纳入自动化测试,故仅覆盖不联网的就绪/路径逻辑。
 * 运行:npm run test 或 node --test --import tsx src/main/services/clip/__tests__/model-downloader.spec.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import {
  CN_IMAGE_MODEL_FILENAME,
  CN_TEXT_MODEL_FILENAME,
  CN_VOCAB_FILENAME,
  getClipModelDir,
  getImageModelPath,
  getTextModelPath,
  getVocabPath,
  isClipModelReady,
  ensureClipModel,
  downloadTo,
  redirectHandled,
  _setClipModelDirForTest,
  _resetClipModelDirForTest,
  _createTestClipModelDir,
} from '../model-downloader.ts';

/** 当前用例的临时模型目录 */
let tempDir = '';
/** 三个模型文件名 */
const FILES = [CN_IMAGE_MODEL_FILENAME, CN_TEXT_MODEL_FILENAME, CN_VOCAB_FILENAME];

/** 在模型目录中放置全部 3 个模型文件 */
function placeAllFiles(): void {
  for (const f of FILES) {
    writeFileSync(join(tempDir, f), 'x');
  }
}

/** 清空模型目录(保持目录本身存在) */
function clearDir(): void {
  for (const f of readdirSync(tempDir)) {
    rmSync(join(tempDir, f), { recursive: true, force: true });
  }
}

describe('model-downloader', () => {
  before(() => {
    tempDir = _createTestClipModelDir();
    _setClipModelDirForTest(tempDir);
  });

  after(() => {
    _resetClipModelDirForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearDir();
  });

  describe('路径辅助函数', () => {
    it('getClipModelDir 返回注入的临时目录', async () => {
      assert.equal(await getClipModelDir(), tempDir);
    });

    it('三个权重路径均落在模型目录下且文件名正确', async () => {
      assert.equal(basename(await getImageModelPath()), CN_IMAGE_MODEL_FILENAME);
      assert.equal(basename(await getTextModelPath()), CN_TEXT_MODEL_FILENAME);
      assert.equal(basename(await getVocabPath()), CN_VOCAB_FILENAME);
      for (const p of [await getImageModelPath(), await getTextModelPath(), await getVocabPath()]) {
        assert.equal(join(tempDir, basename(p)), p);
      }
      assert.ok((await getImageModelPath()).startsWith(tempDir));
      assert.ok((await getTextModelPath()).startsWith(tempDir));
      assert.ok((await getVocabPath()).startsWith(tempDir));
    });
  });

  describe('isClipModelReady', () => {
    it('无任何文件时返回 false', async () => {
      assert.equal(await isClipModelReady(), false);
    });

    it('仅部分文件存在时返回 false', async () => {
      writeFileSync(join(tempDir, CN_IMAGE_MODEL_FILENAME), 'x');
      assert.equal(await isClipModelReady(), false);
    });

    it('全部文件存在时返回 true', async () => {
      placeAllFiles();
      assert.equal(await isClipModelReady(), true);
    });
  });

  describe('ensureClipModel', () => {
    it('模型已就绪时直接返回 true 且不改动目录', async () => {
      placeAllFiles();
      const beforeStat = readdirSync(tempDir).sort();
      const ready = await ensureClipModel();
      assert.equal(ready, true);
      // 目录内容未被改写(无半成品/临时文件)
      assert.deepEqual(readdirSync(tempDir).sort(), beforeStat);
    });
  });

  describe('redirectHandled', () => {
    it('识别常见重定向状态码', () => {
      for (const c of [301, 302, 303, 307, 308]) assert.equal(redirectHandled(c), true);
      for (const c of [200, 206, 404, 500]) assert.equal(redirectHandled(c), false);
    });
  });

  describe('downloadTo(HTTP 重定向跟随)', () => {
    it('302 → 最终 200 时完整下载目标文件', async () => {
      // 起一个本地 HTTP 服务:/redirect → 302 到 /file,/file → 200 返回内容
      const server = createServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/file' });
          res.end();
          return;
        }
        if (req.url === '/file') {
          const body = 'redirected-content';
          res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(body)) });
          res.end(body);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      try {
        const dest = join(tempDir, 'redirect-test.bin');
        await downloadTo(`http://127.0.0.1:${port}/redirect`, dest);
        assert.equal(readFileSync(dest, 'utf8'), 'redirected-content');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('外部在重定向环路时(301 自我)拒绝并抛出', async () => {
      const server = createServer((_req, res) => {
        res.writeHead(301, { Location: '/loop' });
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      try {
        const dest = join(tempDir, 'loop-test.bin');
        await assert.rejects(
          () => downloadTo(`http://127.0.0.1:${port}/loop`, dest),
          /重定向次数过多/,
        );
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
