/**
 * LLM 提示词模板纯函数单测
 * 职责:验证 buildKeywordPrompt / buildSceneMatchPrompt 的用户消息构造格式,
 *      以及系统提示词常量包含关键约束,防止提示词格式回归
 * 运行:npm run test 或 node --test --import tsx src/main/services/llm/__tests__/prompts.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKeywordPrompt,
  buildSceneMatchPrompt,
  KEYWORD_EXTRACTION_SYSTEM,
  SCENE_MATCH_SYSTEM,
} from '../prompts.ts';

describe('buildKeywordPrompt', () => {
  it('包含文案与默认最大关键词数', () => {
    const out = buildKeywordPrompt('这段视频文案');
    assert.ok(out.includes('这段视频文案'));
    assert.ok(out.includes('最多 10 个'));
  });

  it('自定义最大关键词数生效', () => {
    const out = buildKeywordPrompt('text', 5);
    assert.ok(out.includes('最多 5 个'));
  });
});

describe('buildSceneMatchPrompt', () => {
  it('包含段落与编号画面列表', () => {
    const out = buildSceneMatchPrompt('我的段落', ['画面A', '画面B']);
    assert.ok(out.includes('我的段落'));
    assert.ok(out.includes('1. 画面A'));
    assert.ok(out.includes('2. 画面B'));
  });

  it('空画面列表时编号部分为空', () => {
    const out = buildSceneMatchPrompt('段落', []);
    assert.ok(out.includes('段落'));
    assert.ok(!out.includes('1.'));
  });
});

describe('系统提示词常量', () => {
  it('关键词抽取提示词要求 JSON 数组输出', () => {
    assert.ok(KEYWORD_EXTRACTION_SYSTEM.includes('JSON 数组'));
    assert.ok(KEYWORD_EXTRACTION_SYSTEM.includes('不超过 8 个字'));
  });

  it('画面匹配提示词包含匹配要求', () => {
    assert.ok(SCENE_MATCH_SYSTEM.includes('画面'));
    assert.ok(SCENE_MATCH_SYSTEM.includes('JSON 数组'));
  });
});
