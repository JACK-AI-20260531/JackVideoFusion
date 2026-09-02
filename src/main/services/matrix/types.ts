/**
 * 矩阵分组服务 - 类型定义(PRD-v2.1 FR-6/7)
 * 职责:平台分组矩阵的结构(分组 = 名称 + 平台集合)
 */
/** 矩阵分组(按 name 唯一) */
export interface MatrixGroup {
  /** 分组 ID(保存时生成,同名覆盖不变) */
  id: string;
  /** 分组名称(唯一标识) */
  name: string;
  /** 分组包含的平台集合 */
  platforms: string[];
  /** 创建时间(ISO 8601) */
  createdAt: string;
  /** 最后更新时间(ISO 8601) */
  updatedAt: string;
}
