/**
 * 流水线校验纯函数单测(PRD-v2.1 FR-2)
 * 运行:node --test --import tsx src/main/services/pipeline/__tests__/validate.spec.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule, validateSteps } from '../validate';
import type { PipelineStep } from '../types';

describe('validateSchedule', () => {
  test('undefined 合法(不定时)', () => {
    assert.equal(validateSchedule(undefined), null);
  });

  test('at 非法 HH:mm 报错', () => {
    assert.ok(validateSchedule({ kind: 'daily', at: 'x' }));
    assert.ok(validateSchedule({ kind: 'daily', at: '24:00' }));
    assert.ok(validateSchedule({ kind: 'daily', at: '08:60' }));
  });

  test('weekly 缺 weekday 报错;weekday 越界(7)报错', () => {
    assert.ok(validateSchedule({ kind: 'weekly', at: '08:00' }));
    assert.ok(validateSchedule({ kind: 'weekly', at: '08:00', weekday: 7 }));
    assert.ok(validateSchedule({ kind: 'weekly', at: '08:00', weekday: -1 }));
  });

  test('daily 08:00 合法返回 null', () => {
    assert.equal(validateSchedule({ kind: 'daily', at: '08:00' }), null);
    assert.equal(validateSchedule({ kind: 'weekly', at: '08:00', weekday: 1 }), null);
    assert.equal(validateSchedule({ kind: 'once', at: '20:30' }), null);
  });
});

describe('validateSteps', () => {
  test('空 steps 报错', () => {
    assert.ok(validateSteps([]));
  });

  test('material-split 缺字段报错,齐全则通过', () => {
    const ok: PipelineStep = {
      type: 'material-split',
      params: { files: ['F:/a.mp4'], segmentSec: 5, outputDir: 'F:/out' },
    };
    assert.equal(validateSteps([ok]), null);
    assert.ok(
      validateSteps([{ type: 'material-split', params: { files: [], segmentSec: 5, outputDir: 'x' } }]),
    );
    assert.ok(
      validateSteps([{ type: 'material-split', params: { files: ['a'], segmentSec: 0, outputDir: 'x' } }]),
    );
    assert.ok(
      validateSteps([{ type: 'material-split', params: { files: ['a'], segmentSec: 5, outputDir: '' } }]),
    );
  });

  test('video-mix-random:mode/folderIds 校验', () => {
    const ok: PipelineStep = {
      type: 'video-mix-random',
      params: {
        params: { mode: 'random', folderIds: ['f1'], resolution: '1080p', keepOriginalQuality: false },
      },
    };
    assert.equal(validateSteps([ok]), null);
    assert.ok(
      validateSteps([{ type: 'video-mix-random', params: { params: { mode: 'bad', folderIds: ['f1'] } } }]),
    );
    assert.ok(
      validateSteps([{ type: 'video-mix-random', params: { params: { mode: 'random', folderIds: [] } } }]),
    );
  });

  test('auto-publish:platform 非法/缺 title 报错;videoPath 允许为空', () => {
    const ok: PipelineStep = {
      type: 'auto-publish',
      params: {
        params: { platform: 'douyin', videoPath: '', title: '标题' },
        usePrevArtifact: true,
      },
    };
    assert.equal(validateSteps([ok]), null);
    assert.ok(
      validateSteps([{ type: 'auto-publish', params: { params: { platform: 'xxx', videoPath: '', title: 't' } } }]),
    );
    assert.ok(
      validateSteps([{ type: 'auto-publish', params: { params: { platform: 'douyin', videoPath: '', title: '' } } }]),
    );
  });

  test('未知 type 报错', () => {
    assert.ok(validateSteps([{ type: 'nope', params: {} }]));
  });
});
