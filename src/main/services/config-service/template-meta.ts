/**
 * 模板元数据纯函数工具
 * 职责:提供模板数组到元数据列表的排序/剥离纯逻辑,便于单元测试(不依赖 electron)
 */
import type { ConfigTemplate, ConfigTemplateMeta } from './types';

/**
 * 将模板数组按更新时间降序转换为元数据列表(仅保留展示字段,剥离 config)
 * @param templates 模板数组
 * @returns 元数据列表(按 updatedAt 降序)
 */
export function toTemplatesMeta(templates: ConfigTemplate[]): ConfigTemplateMeta[] {
  return [...templates]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(({ name, description, createdAt, updatedAt }) => ({
      name,
      description,
      createdAt,
      updatedAt,
    }));
}
