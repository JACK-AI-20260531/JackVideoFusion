/**
 * 智能封面纯函数单测
 * 职责:验证 pickFrameTimes 抽帧时刻、truncateCoverText 文案截断、
 *      buildCoverPath 输出路径、findChineseFontFile 字体查找
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/cover.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pickFrameTimes,
  truncateCoverText,
  buildCoverPath,
  findChineseFontFile,
  COVER_TEXT_MAX_LEN,
} from '../cover.ts';

describe('pickFrameTimes', () => {
  it('返回 25%/50%/75% 三处时刻', () => {
    const times = pickFrameTimes(100);
    assert.deepEqual(times, [25, 50, 75]);
  });

  it('非正时长回退到 0', () => {
    assert.deepEqual(pickFrameTimes(0), [0]);
    assert.deepEqual(pickFrameTimes(-5), [0]);
  });
});

describe('truncateCoverText', () => {
  it('不超长时原样返回并去首尾空白', () => {
    assert.equal(truncateCoverText('  你好  '), '你好');
  });

  it('超长时截断并以省略号结尾', () => {
    const text = '一'.repeat(COVER_TEXT_MAX_LEN + 3);
    const out = truncateCoverText(text);
    assert.equal(out.length, COVER_TEXT_MAX_LEN + 1);
    assert.ok(out.endsWith('…'));
  });
});

describe('buildCoverPath', () => {
  it('与视频同目录,前缀 cover- 且去掉原扩展名', () => {
    const p = buildCoverPath('F:\\videos\\demo.mp4');
    assert.equal(p, join('F:\\videos', 'cover-demo.jpg'));
  });
});

describe('findChineseFontFile', () => {
  it('目录内命中候选字体则返回完整路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jvf-font-'));
    try {
      writeFileSync(join(dir, 'msyh.ttc'), 'x');
      assert.equal(findChineseFontFile(dir), join(dir, 'msyh.ttc'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录内无候选字体返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jvf-font-'));
    try {
      writeFileSync(join(dir, 'other.ttf'), 'x');
      assert.equal(findChineseFontFile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
