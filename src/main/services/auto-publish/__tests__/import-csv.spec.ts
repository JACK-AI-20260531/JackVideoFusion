/**
 * CSV 批量清单导入纯函数单测
 * 职责:验证 parseCsvText 引号转义/引号内逗号换行/BOM、rowsToTasks 表头别名与逐行校验、
 *      parseScheduledAt 时间解析、readCsvText 编码解码
 * 运行:npm run test 或 node --test --import tsx src/main/services/auto-publish/__tests__/import-csv.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, rmSync } from 'fs';
import {
  parseCsvText,
  rowsToTasks,
  buildCsvTemplate,
  readCsvText,
  parseScheduledAt,
} from '../import-csv.ts';

const NOW = Date.parse('2026-09-01T00:00:00.000Z');

/** fileExists 注入:仅 /exists/ 开头的路径视为存在 */
const fileExists = (p: string): boolean => p.startsWith('exists:');

describe('parseCsvText', () => {
  it('解析简单多行多列', () => {
    const table = parseCsvText('a,b,c\n1,2,3');
    assert.deepEqual(table, [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('处理引号内逗号/换行与双引号转义', () => {
    const table = parseCsvText('title,desc\n"含,逗号","含""引号"""');
    assert.equal(table[1][0], '含,逗号');
    assert.equal(table[1][1], '含"引号"');
  });

  it('剥离 BOM 并忽略空行', () => {
    const table = parseCsvText('﻿a,b\n\n1,2\n');
    assert.deepEqual(table, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseScheduledAt', () => {
  it('yyyy-MM-dd HH:mm 按本地时区解析并转 ISO', () => {
    // 与本地时区无关:按本地时间构造期望值
    const expected = new Date(2026, 9, 1, 18, 0).toISOString();
    assert.equal(parseScheduledAt('2026-10-01 18:00', NOW), expected);
  });

  it('过去时间/非法格式抛错', () => {
    assert.throws(() => parseScheduledAt('2025-01-01 00:00', NOW));
    assert.throws(() => parseScheduledAt('bad', NOW));
  });

  it('空返回 undefined', () => {
    assert.equal(parseScheduledAt(undefined, NOW), undefined);
    assert.equal(parseScheduledAt('', NOW), undefined);
  });
});

describe('rowsToTasks', () => {
  const header = 'videoPath,platform,title,description,tags,coverPath,scheduledAt';

  it('合法行映射完整,tags 按分号拆分', () => {
    const result = rowsToTasks(
      parseCsvText(
        `${header}\nexists:a.mp4,抖音,标题一,描述,搞笑;日常,,2026-10-01 18:00`,
        ),
      { fileExists, now: NOW },
    );
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].platform, 'douyin');
    assert.deepEqual(result.rows[0].tags, ['搞笑', '日常']);
    const expectedIso = new Date(2026, 9, 1, 18, 0).toISOString();
    assert.equal(result.rows[0].scheduledAt, expectedIso);
  });

  it('逐行校验失败隔离,记录行号与原因', () => {
    const result = rowsToTasks(
      parseCsvText(`${header}\nexists:a.mp4,抖音,标题,,\n,抖音,无路径\nexists:b.mp4,不支持平台,标题\nexists:c.mp4,快手,,`),
      { fileExists, now: NOW },
    );
    assert.equal(result.total, 4);
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 3);
    // 行号从 2 起(1 为表头):数据行 1 合法,2-4 行失败
    assert.deepEqual(result.errors.map((e) => e.line), [3, 4, 5]);
  });

  it('支持中文表头与中文平台名', () => {
    const result = rowsToTasks(parseCsvText('视频路径,平台,标题\nexists:a.mp4,小红书,标题'), {
      fileExists,
      now: NOW,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].platform, 'xiaohongshu');
  });

  it('缺少必需列表头时抛错', () => {
    assert.throws(() => rowsToTasks(parseCsvText('videoPath,title\nexists:a.mp4,t'), { fileExists, now: NOW }));
  });
});

describe('buildCsvTemplate', () => {
  it('包含表头与示例行', () => {
    const tpl = buildCsvTemplate();
    assert.ok(tpl.startsWith('videoPath,platform,title'));
    assert.ok(tpl.split('\n').length >= 3);
  });
});

describe('readCsvText', () => {
  it('UTF-8 BOM 自动剥离', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('抖音', 'utf8')]);
    const tmp = join(tmpdir(), `jvf-test-${Date.now()}.csv`);
    writeFileSync(tmp, buf);
    try {
      assert.equal(readCsvText(tmp), '抖音');
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('无 BOM 按 GBK 解码', () => {
    // "抖音" 的 GBK 编码字节
    const tmp = join(tmpdir(), `jvf-test-gbk-${Date.now()}.csv`);
    writeFileSync(tmp, Buffer.from([0xb6, 0xb6, 0xd2, 0xf4]));
    try {
      assert.equal(readCsvText(tmp), '抖音');
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
