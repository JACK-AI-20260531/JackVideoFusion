/**
 * 音色库元数据校验纯逻辑单测
 * 职责:验证 isValidVoice 类型守卫对音色记录的合法性校验
 * 说明:纯函数;voiceLibrary 的文件读写方法不在此测
 * 运行:npm run test 或 node --test --import tsx src/main/services/voice-clone/__tests__/library.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidVoice } from '../voice-library.ts';

function validVoice() {
  return {
    id: 'id-1',
    name: '示例音色',
    samplePath: '/a.wav',
    refAudioPath: '/b.wav',
    refText: '你好',
    language: 'zh',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isValidVoice', () => {
  it('合法音色记录返回 true', () => {
    assert.equal(isValidVoice(validVoice()), true);
  });

  it('null / 非对象返回 false', () => {
    assert.equal(isValidVoice(null), false);
    assert.equal(isValidVoice(undefined), false);
    assert.equal(isValidVoice('string'), false);
    assert.equal(isValidVoice(42), false);
  });

  it('缺失任一必需字段返回 false', () => {
    const fields = ['id', 'name', 'samplePath', 'refAudioPath', 'refText', 'language', 'createdAt'];
    for (const f of fields) {
      const bad = validVoice();
      delete bad[f];
      assert.equal(isValidVoice(bad), false, `缺 ${f} 应返回 false`);
    }
  });

  it('字段类型不符返回 false', () => {
    const bad = validVoice();
    bad.id = 123 as never;
    assert.equal(isValidVoice(bad), false);
  });
});
