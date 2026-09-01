/**
 * 撤销/重做命令栈单测(PRD-文本即时间线 v2.0 FR-5)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandStack } from '../command-stack';

describe('CommandStack', () => {
  it('apply/undo/redo 基本流转', () => {
    const stack = new CommandStack<number>(0);
    stack.apply(1);
    stack.apply(2);
    assert.equal(stack.get(), 2);
    assert.equal(stack.undo(), 1);
    assert.equal(stack.undo(), 0);
    assert.equal(stack.undo(), null); // 到底
    assert.equal(stack.redo(), 1);
    assert.equal(stack.redo(), 2);
    assert.equal(stack.redo(), null); // 到顶
  });

  it('apply 后清空重做栈', () => {
    const stack = new CommandStack<number>(0);
    stack.apply(1);
    stack.undo();
    stack.apply(2);
    assert.equal(stack.canRedo(), false);
    assert.equal(stack.get(), 2);
  });

  it('默认保留至少 20 步', () => {
    const stack = new CommandStack<number>(0);
    for (let i = 1; i <= 30; i++) stack.apply(i);
    // 连续撤销最多 20 步
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const v = stack.undo();
      if (v === null) break;
      last = v;
    }
    assert.equal(last, 10);
  });

  it('容量超限裁剪最旧状态', () => {
    const stack = new CommandStack<number>(0, 5);
    for (let i = 1; i <= 5; i++) stack.apply(i);
    // 撤销 5 次回到 0,再撤销无路可返
    for (let i = 0; i < 5; i++) stack.undo();
    assert.equal(stack.undo(), null);
    assert.equal(stack.get(), 0);
  });
});
