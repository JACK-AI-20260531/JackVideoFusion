/**
 * 混剪参数模板服务 - 类型定义
 * 职责:任务级 MixParams 快照的模板结构(PRD-v2.1 FR-1)
 * 与 config-service 的 ConfigTemplate(全局配置快照)互不影响
 */
import type { MixParams } from '../video-mix/types';

/** 混剪参数模板(按 name 唯一) */
export interface MixTemplate {
  /** 模板 ID(保存时生成,同名覆盖不变) */
  id: string;
  /** 模板名称(唯一标识) */
  name: string;
  /** 模板描述(可选) */
  description?: string;
  /** 混剪参数快照 */
  params: MixParams;
  /** 创建时间(ISO 8601) */
  createdAt: string;
  /** 最后更新时间(ISO 8601) */
  updatedAt: string;
}

/** 模板元数据(列表展示用,不含 params) */
export interface MixTemplateMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
