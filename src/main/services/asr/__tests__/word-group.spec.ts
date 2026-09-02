/**
 * Whisper 词级时间戳分组单测(PRD-文本即时间线 v2.0 尽力而为项)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupWordChunks } from '../engine';
import type { AsrWord } from '../types';

function w(text: string, startSec: number, endSec: number): AsrWord {
  return { text, startSec, endSec };
}

describe('groupWordChunks', () => {
  it('按句终止符分组,words 保留在段上', () => {
    const segs = groupWordChunks([
      w('嗯', 0.2, 0.6),
      w('大家', 0.6, 1.2),
      w('好', 1.2, 1.4),
      w('。', 1.4, 1.5),
      w('今天', 1.6, 2.2),
      w('聊聊', 2.2, 2.6),
      w('剪辑', 2.6, 3.2),
      w('。', 3.2, 3.3),
    ]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].text, '嗯大家好。');
    assert.equal(segs[0].startSec, 0.2);
    assert.equal(segs[0].endSec, 1.5);
    assert.equal(segs[0].words?.length, 4);
    assert.equal(segs[1].text, '今天聊聊剪辑。');
    assert.equal(segs[1].startSec, 1.6);
  });

  it('末尾无终止符也强制收尾', () => {
    const segs = groupWordChunks([w('没有', 0, 1), w('句号', 1, 2)]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, '没有句号');
    assert.equal(segs[0].endSec, 2);
  });

  it('英文词间自动补空格', () => {
    const segs = groupWordChunks([w('Hello', 0, 0.5), w('everyone', 0.5, 1.0), w('!', 1.0, 1.1)]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, 'Hello everyone!');
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(groupWordChunks([]), []);
  });
});
