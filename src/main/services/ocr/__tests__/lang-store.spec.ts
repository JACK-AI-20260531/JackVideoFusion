/**
 * OCR 语言包管理单测
 * 职责:验证数据目录解析、语言包路径、就绪检测与已就绪时的 ensureLangReady 快捷返回。
 * 说明:通过 _setOcrDataDirForTest 注入临时目录,绕过 electron app 依赖;
 *      真实下载路径(缺失语言包时的网络请求)依赖外部 CDN,不适合自动化测试,
 *      故仅覆盖不联网的就绪/路径逻辑。
 * 运行:npm run test 或 node --test --import tsx src/main/services/ocr/__tests__/lang-store.spec.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import {
  getOcrDataDir,
  langPackPath,
  isLangReady,
  ensureLangReady,
  checkLangReadySafe,
  _setOcrDataDirForTest,
  _resetOcrDataDirForTest,
  _createTestOcrDataDir,
} from '../lang-store.ts';

let tempDir = '';

describe('lang-store', () => {
  before(() => {
    tempDir = _createTestOcrDataDir();
    _setOcrDataDirForTest(tempDir);
  });

  after(() => {
    _resetOcrDataDirForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const f of readdirSync(tempDir)) {
      rmSync(join(tempDir, f), { recursive: true, force: true });
    }
  });

  it('getOcrDataDir 返回注入的临时目录', () => {
    assert.equal(getOcrDataDir(), tempDir);
  });

  it('langPackPath 生成带 .traineddata.gz 后缀的路径', () => {
    assert.equal(basename(langPackPath('chi_sim')), 'chi_sim.traineddata.gz');
    assert.equal(basename(langPackPath('eng')), 'eng.traineddata.gz');
    assert.ok(langPackPath('chi_sim').startsWith(tempDir));
  });

  it('isLangReady:无文件返回 false', async () => {
    assert.equal(await isLangReady('chi_sim'), false);
  });

  it('isLangReady:文件存在返回 true', async () => {
    writeFileSync(langPackPath('chi_sim'), 'x');
    assert.equal(await isLangReady('chi_sim'), true);
  });

  it('ensureLangReady:语言包已就绪时直接返回目录且不新增文件', async () => {
    writeFileSync(langPackPath('eng'), 'x');
    const dir = await ensureLangReady('eng');
    assert.equal(dir, tempDir);
    // 目录内容未新增(无半成品)
    const files = readdirSync(tempDir);
    assert.deepEqual(files, ['eng.traineddata.gz']);
  });

  it('checkLangReadySafe:就绪返回 true,缺失返回 false 且不抛错', async () => {
    assert.equal(await checkLangReadySafe('chi_sim'), false);
    writeFileSync(langPackPath('chi_sim'), 'x');
    assert.equal(await checkLangReadySafe('chi_sim'), true);
  });
});
