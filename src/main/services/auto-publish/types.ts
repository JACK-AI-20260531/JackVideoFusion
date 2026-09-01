/**
 * 自动发布服务类型定义
 *
 * 职责:声明多平台自动发布模块对外/对内的所有数据结构,包括:
 *   - 平台标识与登录状态枚举
 *   - 账号信息(AccountInfo)、发布参数(PublishParams)
 *   - 发布任务(PublishTask)、发布结果(PublishResult)
 *   - 平台适配器接口(PlatformAdapter)
 *   - 浏览器上下文配置(BrowserContextConfig)
 *
 * 设计约定:
 *   - 使用 playwright-core 驱动系统已安装的 Chrome/Edge,避免重复下载浏览器
 *   - 每平台一个 userDataDir 持久化登录态,扫码登录后复用
 *   - PlatformAdapter 抽象接口,每平台一个实现类(BasePlatformAdapter 提供模板方法)
 */
import type { CancelToken } from '../ffmpeg/types';

/** 支持的发布平台 */
export type PublishPlatform =
  | 'douyin'
  | 'kuaishou'
  | 'xiaohongshu'
  | 'bilibili'
  | 'shipinhao'; // 微信视频号(V1.3 补齐 PRD FR-4.6 平台清单)

/** 登录状态 */
export type LoginStatus = 'logged-out' | 'logged-in' | 'expired';

/** 平台账号信息 */
export interface AccountInfo {
  /** 所属平台 */
  platform: PublishPlatform;
  /** 账号昵称(登录后获取,未登录为空) */
  nickname?: string;
  /** 头像 URL(登录后获取) */
  avatar?: string;
  /** 当前登录状态 */
  loginStatus: LoginStatus;
  /** 最近一次活跃时间(ISO 字符串) */
  lastActiveAt?: string;
}

/** 发布参数(渲染层 → 主进程 → 适配器) */
export interface PublishParams {
  /** 目标平台 */
  platform: PublishPlatform;
  /** 视频文件绝对路径 */
  videoPath: string;
  /** 视频标题 */
  title: string;
  /** 视频描述(可选) */
  description?: string;
  /** 话题标签列表(如 ['搞笑', '日常'],发布时拼接为 #搞笑 #日常) */
  tags?: string[];
  /** 封面图片路径(可选) */
  coverPath?: string;
  /** 定时发布时间(ISO 字符串,可选;为空则立即发布) */
  scheduledAt?: string;
}

/** 发布任务状态(本地流转用,与 TaskItem.status 解耦) */
export type PublishTaskStatus =
  | 'pending' // 排队中
  | 'running' // 执行中
  | 'paused' // 已暂停(可恢复)
  | 'completed' // 已完成
  | 'failed' // 失败
  | 'cancelled'; // 已取消

/** 发布任务 */
export interface PublishTask {
  /** 任务唯一标识 */
  id: string;
  /** 发布参数 */
  params: PublishParams;
  /** 当前任务状态 */
  status: PublishTaskStatus;
  /** 进度百分比 0-100 */
  progress: number;
  /** 失败原因 */
  error?: string;
  /** 发布结果 */
  result?: PublishResult;
  /** 创建时间(ISO 字符串) */
  createdAt: string;
}

/** 发布结果 */
export interface PublishResult {
  /** 所属平台 */
  platform: PublishPlatform;
  /** 发布后的视频 URL(可选,部分平台不易获取) */
  videoUrl?: string;
  /** 发布时间(ISO 字符串) */
  publishTime: string;
  /** 是否成功 */
  success: boolean;
  /** 半自动降级模式(生成物料包+打开上传页,由用户手动完成;PRD-v1.7 FR-4) */
  assisted?: boolean;
  /** 半动物料包文件路径(assisted=true 时存在) */
  kitPath?: string;
}

/**
 * 平台适配器接口
 * 每个平台实现该接口,封装登录态检测、登录、登出与发布流程
 */
export interface PlatformAdapter {
  /** 打开浏览器到平台登录页,等待用户扫码登录 */
  login(token?: CancelToken): Promise<AccountInfo>;
  /** 检查当前是否已登录(基于持久化 userDataDir) */
  checkLogin(): Promise<AccountInfo>;
  /** 退出登录(清除持久化登录态) */
  logout(): Promise<void>;
  /** 执行视频发布流程 */
  publish(params: PublishParams, token: CancelToken, onProgress: (p: number) => void): Promise<PublishResult>;
  /**
   * 采集视频数据(播放/点赞/评论,可选实现)
   * 未实现的平台抛错,调用方降级提示"暂不可用"
   */
  fetchStats?(videoUrl: string): Promise<VideoStats>;
}

/** 浏览器上下文配置 */
export interface BrowserContextConfig {
  /** 浏览器可执行文件路径(系统 Chrome/Edge) */
  executablePath: string;
  /** 用户数据目录(持久化登录态) */
  userDataDir: string;
  /** 是否无头模式 */
  headless: boolean;
}

/** 进度回调签名 */
export type ProgressCallback = (progress: number) => void;

/** 视频数据采集项(发布数据回收,PRD v1.6 FR-1) */
export interface VideoStats {
  /** 播放数(平台可见才填) */
  plays?: number;
  /** 点赞数 */
  likes?: number;
  /** 评论数 */
  comments?: number;
  /** 采集时间(ISO) */
  collectedAt: string;
}
