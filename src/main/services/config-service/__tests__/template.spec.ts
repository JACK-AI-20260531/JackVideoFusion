/**
 * 参数模板元数据处理纯函数单测
 * 职责:验证 toTemplatesMeta 的剥离 config 与按更新时间降序排序逻辑
 *      该类纯函数不依赖 electron,可在 Node 环境直接测试
 * 运行:node --test --experimental-strip-types src/main/services/config-service/__tests__/template.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toTemplatesMeta } from '../template-meta.ts';
import type { ConfigTemplate } from '../types.ts';

/**
 * 构造一条测试模板
 * @param name 模板名
 * @param updatedAt 更新时间
 * @returns ConfigTemplate
 */
function makeTemplate(name: string, updatedAt: string): ConfigTemplate {
  return {
    name,
    description: `${name} 描述`,
    config: { split: { segmentSec: 10 } } as never,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt,
  };
}

describe('toTemplatesMeta', () => {
  it('剥离 config,仅保留元数据字段', () => {
    const meta = toTemplatesMeta([makeTemplate('a', '2021-01-01T00:00:00.000Z')])[0];
    assert.deepEqual(meta, {
      name: 'a',
      description: 'a 描述',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2021-01-01T00:00:00.000Z',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(meta, 'config'), false);
  });

  it('按更新时间降序排列', () => {
    const list = toTemplatesMeta([
      makeTemplate('older', '2020-01-01T00:00:00.000Z'),
      makeTemplate('newer', '2021-01-01T00:00:00.000Z'),
      makeTemplate('middle', '2021-06-01T00:00:00.000Z'),
    ]);
    assert.deepEqual(list.map((m) => m.name), ['middle', 'newer', 'older']);
  });

  it('入参不被原地修改(返回新数组)', () => {
    const templates = [makeTemplate('a', '2021-01-01T00:00:00.000Z')];
    const list = toTemplatesMeta(templates);
    list[0].name = 'mutated';
    assert.equal(templates[0].name, 'a');
  });

  it('空数组返回空数组', () => {
    assert.deepEqual(toTemplatesMeta([]), []);
  });
});
