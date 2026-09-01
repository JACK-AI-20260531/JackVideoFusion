/**
 * 平台发布规格与能力位(PRD-v1.7 数据飞轮与全景矩阵 FR-4)
 *
 * 职责:
 *   - 各平台发布规格约束常量(标题长度/标签数/封面比例/上传页 URL)
 *   - 能力位声明(autoPublish=false 的平台降级为半自动物料包模式)
 *   - 发布前预检(validatePublishSpec,阻断项 + 警告项)
 *   - 半动物料包构造(buildPublishKit)
 *
 * 设计要点:
 *   - 全部纯函数/常量,不依赖 electron,可 node:test 单测
 *   - 预检规则:标题超限/标签超限为阻断(block);标题达上限 90% 为警告(warn)
 *   - 物料包内容为发布所需全部字段,半自动模式下写入磁盘并打开平台上传页
 */
import type { PublishParams, PublishPlatform } from './types';

/** 平台发布规格 */
export interface PublishSpec {
  /** 是否支持全自动发布(false = 半自动物料包降级) */
  autoPublish: boolean;
  /** 标题长度上限(字符,1 个汉字计 1) */
  titleLimit: number;
  /** 话题标签数量上限(0 = 不支持话题) */
  tagLimit: number;
  /** 推荐封面宽高比 */
  coverAspect: '9:16' | '16:9' | '3:4';
  /** 平台上传页 URL(半自动降级打开) */
  uploadUrl: string;
}

/** 各平台发布规格(约束值与平台创作者后台一致) */
export const PUBLISH_SPECS: Record<PublishPlatform, PublishSpec> = {
  douyin: {
    autoPublish: true,
    titleLimit: 55,
    tagLimit: 10,
    coverAspect: '9:16',
    uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  },
  kuaishou: {
    autoPublish: true,
    titleLimit: 50,
    tagLimit: 10,
    coverAspect: '9:16',
    uploadUrl: 'https://cp.kuaishou.com/article/publish/video',
  },
  xiaohongshu: {
    autoPublish: true,
    titleLimit: 20,
    tagLimit: 10,
    coverAspect: '3:4',
    uploadUrl: 'https://creator.xiaohongshu.com/publish/publish',
  },
  bilibili: {
    autoPublish: true,
    titleLimit: 80,
    tagLimit: 10,
    coverAspect: '16:9',
    uploadUrl: 'https://member.bilibili.com/platform/upload/video/frame',
  },
  // 微信视频号创作者接口不稳定,降级为半自动:生成物料包 + 打开上传页
  shipinhao: {
    autoPublish: false,
    titleLimit: 30,
    tagLimit: 0,
    coverAspect: '9:16',
    uploadUrl: 'https://channels.weixin.qq.com/platform/post/create',
  },
};

/** 预检问题项 */
export interface SpecIssue {
  /** block=阻断发布 / warn=仅提示 */
  level: 'block' | 'warn';
  /** 问题字段(title/tags) */
  field: 'title' | 'tags';
  /** 中文描述 */
  message: string;
}

/**
 * 发布参数平台规格预检
 * 规则:标题超限/标签超限为阻断;标题达到上限 90% 为警告
 * @param params 发布参数
 * @param spec 平台规格(默认取 PUBLISH_SPECS[params.platform])
 * @returns 问题项列表(空数组 = 预检通过)
 */
export function validatePublishSpec(
  params: PublishParams,
  spec: PublishSpec = PUBLISH_SPECS[params.platform],
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!params) return issues;

  const title = typeof params.title === 'string' ? params.title : '';
  if (title.trim().length === 0) {
    issues.push({ level: 'block', field: 'title', message: '标题不能为空' });
  } else if (title.length > spec.titleLimit) {
    issues.push({
      level: 'block',
      field: 'title',
      message: `标题超长:当前 ${title.length} 字,上限 ${spec.titleLimit} 字`,
    });
  } else if (title.length >= spec.titleLimit * 0.9) {
    issues.push({
      level: 'warn',
      field: 'title',
      message: `标题接近上限(${title.length}/${spec.titleLimit} 字)`,
    });
  }

  const tags = Array.isArray(params.tags) ? params.tags : [];
  if (tags.length > spec.tagLimit) {
    issues.push({
      level: 'block',
      field: 'tags',
      message: `话题标签过多:当前 ${tags.length} 个,上限 ${spec.tagLimit} 个`,
    });
  }
  return issues;
}

/**
 * 把预检问题项转为单条错误消息(仅含阻断项;无阻断项返回 null)
 * @param issues 预检问题项
 * @returns 阻断消息;无阻断项返回 null
 */
export function specBlockMessage(issues: SpecIssue[]): string | null {
  const blocks = issues.filter((i) => i.level === 'block');
  if (blocks.length === 0) return null;
  return blocks.map((i) => i.message).join(';');
}

/** 半自动发布物料包 */
export interface PublishKit {
  /** 关联任务 ID */
  taskId: string;
  /** 平台标识 */
  platform: PublishPlatform;
  /** 平台中文名 */
  platformName: string;
  /** 标题 */
  title: string;
  /** 描述(可选) */
  description?: string;
  /** 话题标签 */
  tags: string[];
  /** 视频文件路径 */
  videoPath: string;
  /** 封面路径(可选) */
  coverPath?: string;
  /** 平台上传页 URL */
  uploadUrl: string;
  /** 生成时间(ISO) */
  generatedAt: string;
}

/**
 * 构造半自动发布物料包
 * @param taskId 任务 ID
 * @param params 发布参数
 * @param spec 平台规格
 * @param platformName 平台中文名
 * @returns 物料包对象
 */
export function buildPublishKit(
  taskId: string,
  params: PublishParams,
  spec: PublishSpec,
  platformName: string,
): PublishKit {
  return {
    taskId,
    platform: params.platform,
    platformName,
    title: params.title,
    description: params.description,
    tags: params.tags ?? [],
    videoPath: params.videoPath,
    coverPath: params.coverPath,
    uploadUrl: spec.uploadUrl,
    generatedAt: new Date().toISOString(),
  };
}
