/**
 * 多行拼接纯函数单测
 * 职责:验证把路径数组拼接为多行文本(每行一个,过滤空项,去重保留顺序)
 * 运行:node --test --experimental-strip-types src/renderer/utils/__tests__/join-lines.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinLines } from '../join-lines.ts';

describe('joinLines', () => {
  it('多个路径按每行一个拼接', () => {
    assert.equal(joinLines(['a.mp4', 'b.mp4', 'c.mp4']), 'a.mp4\nb.mp4\nc.mp4');
  });

  it('过滤空字符串条目', () => {
    assert.equal(joinLines(['a.mp4', '', 'b.mp4']), 'a.mp4\nb.mp4');
  });

  it('去重并保留首次出现顺序', () => {
    assert.equal(joinLines(['a.mp4', 'b.mp4', 'a.mp4']), 'a.mp4\nb.mp4');
  });

  it('空数组返回空字符串', () => {
    assert.equal(joinLines([]), '');
  });
});
