/**
 * 镜头检测服务入口
 * 导出服务单例与类型,供 IPC 层与上层模块调用。
 */
import { detectShots } from './detector';
import type { DetectOptions, DetectResult } from './types';

export type { Shot, DetectOptions, DetectResult } from './types';

/**
 * 镜头检测服务
 * 封装 detectShots,提供面向对象的调用方式
 */
export class ShotDetectService {
  /**
   * 检测视频镜头边界
   * @param videoPath 视频文件路径
   * @param opts 检测参数(可选)
   * @returns 检测结果
   */
  async detect(videoPath: string, opts?: DetectOptions): Promise<DetectResult> {
    return detectShots(videoPath, opts);
  }
}

/** 镜头检测服务单例 */
export const shotDetectService = new ShotDetectService();
