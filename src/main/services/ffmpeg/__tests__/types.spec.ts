/**
 * FFmpeg 类型层纯逻辑测试
 * 职责:验证 FFmpegError(stderrSummary 截断逻辑)、CancelToken 状态机、generateTaskId
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FFmpegError, CancelToken, generateTaskId } from '../types.ts';

describe('FFmpegError', () => {
  it('默认错误码与 name', () => {
    const e = new FFmpegError('boom');
    assert.equal(e.name, 'FFmpegError');
    assert.equal(e.code, 'FFMPEG_ERROR');
    assert.equal(e.message, 'boom');
  });

  it('自定义错误码与 taskId', () => {
    const e = new FFmpegError('boom', { code: 'ENCODER', taskId: 'abc' });
    assert.equal(e.code, 'ENCODER');
    assert.equal(e.taskId, 'abc');
  });

  it('无 stderr 时 stderrSummary 为 undefined', () => {
    const e = new FFmpegError('boom');
    assert.equal(e.stderr, undefined);
    assert.equal(e.stderrSummary, undefined);
  });

  it('≤5 行完整保留', () => {
    const e = new FFmpegError('boom', { stderr: 'a\nb\nc' });
    assert.equal(e.stderrSummary, 'a\nb\nc');
  });

  it('>5 行截尾保留最后 5 行', () => {
    const e = new FFmpegError('boom', { stderr: '1\n2\n3\n4\n5\n6\n7' });
    assert.equal(e.stderrSummary, '3\n4\n5\n6\n7');
  });

  it('过滤空行并 trim 首尾', () => {
    const e = new FFmpegError('boom', { stderr: '\n  a  \n\nb\n' });
    // 仅整体 trim 首尾;行内部空白保留
    assert.equal(e.stderrSummary, 'a  \nb');
  });

  it('全部为空白/换行时 summary 为 undefined', () => {
    const e = new FFmpegError('boom', { stderr: '  \n\n' });
    assert.equal(e.stderrSummary, undefined);
  });
});

describe('CancelToken', () => {
  it('默认自动生成 id(格式 ts-rand 含连字符)', () => {
    const t = new CancelToken();
    assert.ok(t.id.includes('-'));
    assert.ok(t.id.length > 0);
    assert.equal(t.cancelled, false);
    assert.equal(t.reason, undefined);
  });

  it('可显式指定 id', () => {
    const t = new CancelToken('custom-id');
    assert.equal(t.id, 'custom-id');
  });

  it('cancel 置 cancelled 并使用默认原因', () => {
    const t = new CancelToken('x');
    t.cancel();
    assert.equal(t.cancelled, true);
    assert.equal(t.reason, '用户取消任务');
  });

  it('cancel 可使用自定义原因', () => {
    const t = new CancelToken('x');
    t.cancel('磁盘空间不足');
    assert.equal(t.cancelled, true);
    assert.equal(t.reason, '磁盘空间不足');
  });

  it('重复 cancel 保持已取消', () => {
    const t = new CancelToken('x');
    t.cancel('r1');
    t.cancel('r2');
    assert.equal(t.cancelled, true);
  });
});

describe('generateTaskId', () => {
  it('返回含连字符的字符串', () => {
    const id = generateTaskId();
    assert.equal(typeof id, 'string');
    assert.ok(id.includes('-'));
  });

  it('连字符前后段均非空', () => {
    const id = generateTaskId();
    const [ts, rand] = id.split('-');
    assert.ok(ts && ts.length > 0);
    assert.ok(rand && rand.length > 0);
  });

  it('多次调用返回不同 id', () => {
    const a = generateTaskId();
    const b = generateTaskId();
    assert.notEqual(a, b);
  });
});
