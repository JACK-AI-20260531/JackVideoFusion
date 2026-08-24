/**
 * 通用位置转换工具单测
 * 职责:验证 toFfmpegPosition 九宫格位置映射与未知位置 fallback
 * 运行:npm run test 或 node --test --import tsx src/main/services/common/__tests__/types.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toFfmpegPosition } from '../types.ts';

describe('toFfmpegPosition', () => {
  it('九宫格位置正确映射为 ffmpeg 位置枚举', () => {
    const cases: [string, string][] = [
      ['top-left', 'left-top'],
      ['top-center', 'center-top'],
      ['top-right', 'right-top'],
      ['middle-left', 'left-center'],
      ['center', 'center'],
      ['middle-right', 'right-center'],
      ['bottom-left', 'left-bottom'],
      ['bottom-center', 'center-bottom'],
      ['bottom-right', 'right-bottom'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(
        toFfmpegPosition(input as never),
        expected,
        `位置 ${input} 映射错误`,
      );
    }
  });

  it('未知位置回退到 right-bottom', () => {
    assert.equal(toFfmpegPosition('invalid' as never), 'right-bottom');
  });
});
