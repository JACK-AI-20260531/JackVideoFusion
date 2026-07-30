/**
 * 素材仓库模块 - 类型定义
 * 职责:声明 material-repo 对外与内部使用的类型契约
 * 设计要点:(folderId, fileId) 二元组为作用域单位,所有抽取 API 均围绕单 folderId 进行
 */
import type { MaterialKind } from '../../../shared/types';

/**
 * 文件夹元信息(主进程侧)
 * 与渲染层 FolderMeta 形状保持一致,但定义在主进程避免反向依赖 renderer
 */
export interface FolderMeta {
  /** 文件夹唯一 ID(注册时生成) */
  id: string;
  /** 文件夹绝对路径 */
  path: string;
  /** 文件夹显示名(取 basename) */
  name: string;
  /** 该文件夹下已扫描到的素材数量 */
  materialCount: number;
  /** 注册时间 ISO 字符串 */
  addedAt: string;
}

/**
 * 单文件夹抽取选项
 * 仅作用于 pickFromFolder,不可跨文件夹
 */
export interface PickOpts {
  /** 仅抽取指定类型的素材 */
  kind?: MaterialKind;
  /** 是否启用跨调用去重(unique=true 时同 folderId 内不重复抽取同一素材) */
  unique?: boolean;
  /** 本次需要排除的素材 ID 列表 */
  excludeIds?: string[];
  /** 随机种子(便于测试复现,不传则使用系统随机) */
  seed?: number;
}

/**
 * 跨文件夹白名单策略
 * 仅作用于 pickAcrossFolders,任何跨文件夹调用必须显式传入此策略
 */
export interface WhitelistPolicy {
  /** 允许的素材类型(白名单),未传表示不限 */
  allowedKinds?: MaterialKind[];
  /** 每个文件夹最多抽取的数量 */
  perFolderLimit?: number;
  /** 跨文件夹调用的业务原因(强制要求,写入审计日志) */
  reason: string;
}

/**
 * 审计日志条目结构(内部使用,序列化后写入 audit.log)
 */
export interface AuditEntry {
  /** 时间戳 ISO 字符串 */
  timestamp: string;
  /** 操作类型 */
  action: 'pickAcrossFolders';
  /** 涉及的文件夹 ID 列表 */
  folderIds: string[];
  /** 业务原因 */
  reason: string;
  /** 白名单策略快照 */
  policy: WhitelistPolicy;
  /** 本次返回的素材数量 */
  resultCount: number;
}
