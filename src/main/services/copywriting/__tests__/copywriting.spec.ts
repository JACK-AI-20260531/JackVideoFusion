/**
 * 文案生成纯函数单测:平台风格表 / prompt 构造 / JSON 容错解析(PRD-v2.2 FR-1)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_STYLE,
  COPYWRITING_SYSTEM,
  buildCopyPrompt,
  parseCopyResponse,
  extractJsonObject,
} from '../copywriting.ts';

const ALL_PLATFORMS = Object.keys(PLATFORM_STYLE) as (keyof typeof PLATFORM_STYLE)[];

test('buildCopyPrompt: 五平台风格要点齐全且 JSON 约束在 system 消息', () => {
  for (const platform of ALL_PLATFORMS) {
    const messages = buildCopyPrompt('测试标题', platform);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('JSON'));
    assert.ok(messages[0].content.includes('titles'));
    // system 消息须含该平台无关的通用约束,user 消息须含平台风格与原始标题
    assert.ok(messages[1].content.includes('测试标题'));
    assert.ok(messages[1].content.includes(PLATFORM_STYLE[platform].styleHint));
    assert.ok(messages[1].content.includes(PLATFORM_STYLE[platform].label));
  }
});

test('buildCopyPrompt: system 消息为全局常量,含 titles/description/tags 字段约束', () => {
  assert.ok(COPYWRITING_SYSTEM.includes('titles'));
  assert.ok(COPYWRITING_SYSTEM.includes('description'));
  assert.ok(COPYWRITING_SYSTEM.includes('tags'));
});

test('parseCopyResponse: 正常 JSON 直解', () => {
  const raw = '{"titles":["A标题","B标题","C标题"],"description":"这是一段描述","tags":["搞笑","日常"]}';
  const parsed = parseCopyResponse(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.titles, ['A标题', 'B标题', 'C标题']);
  assert.equal(parsed.description, '这是一段描述');
  assert.deepEqual(parsed.tags, ['搞笑', '日常']);
});

test('parseCopyResponse: 带markdown围栏的输出可解析', () => {
  const raw = '```json\n{"titles":["标题一"],"description":"描述","tags":["a","b"]}\n```';
  const parsed = parseCopyResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed.titles[0], '标题一');
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('parseCopyResponse: JSON 前后混入解释文字时截取对象', () => {
  const raw = '好的,以下是文案:{"titles":["T"],"description":"D","tags":["x"]} 请查收';
  const parsed = parseCopyResponse(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.titles, ['T']);
});

test('parseCopyResponse: 坏 JSON 返回 null', () => {
  assert.equal(parseCopyResponse('这不是 JSON'), null);
  assert.equal(parseCopyResponse('{"titles": [未闭合'), null);
  assert.equal(parseCopyResponse(''), null);
  assert.equal(parseCopyResponse(null as unknown as string), null);
});

test('parseCopyResponse: 缺 titles 或 titles 全空返回 null', () => {
  assert.equal(parseCopyResponse('{"description":"d","tags":[]}'), null);
  assert.equal(parseCopyResponse('{"titles":[],"description":"d"}'), null);
  assert.equal(parseCopyResponse('{"titles":["","  "]}'), null);
});

test('parseCopyResponse: 缺 description/tags 降级不报错', () => {
  const parsed = parseCopyResponse('{"titles":["T1","T2"]}');
  assert.ok(parsed);
  assert.equal(parsed.description, '');
  assert.deepEqual(parsed.tags, []);
});

test('parseCopyResponse: tags 去井号/去空/去重并截断 8 个', () => {
  const raw = JSON.stringify({
    titles: ['T'],
    description: '',
    tags: ['#a', 'a', '##b', '', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
  });
  const parsed = parseCopyResponse(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(parsed.tags.length, 8);
});

test('parseCopyResponse: titles 超过 3 个截断为 3', () => {
  const raw = JSON.stringify({ titles: ['1', '2', '3', '4', '5'], description: '', tags: [] });
  const parsed = parseCopyResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed.titles.length, 3);
});

test('extractJsonObject: 花括号嵌套与字符串内花括号不干扰截取', () => {
  assert.equal(extractJsonObject('x {"a":{"b":"}"}} y'), '{"a":{"b":"}"}}');
  assert.equal(extractJsonObject('no braces'), null);
  assert.equal(extractJsonObject('{"a": 1'), null);
});

test('PLATFORM_STYLE: 覆盖五平台且字数/标签区间合法', () => {
  const platforms: string[] = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'shipinhao'];
  for (const p of platforms) {
    const style = PLATFORM_STYLE[p as keyof typeof PLATFORM_STYLE];
    assert.ok(style.label.length > 0);
    assert.ok(style.styleHint.length > 0);
    assert.ok(style.titleRange[0] <= style.titleRange[1]);
    assert.ok(style.tagCount[0] <= style.tagCount[1]);
  }
});
