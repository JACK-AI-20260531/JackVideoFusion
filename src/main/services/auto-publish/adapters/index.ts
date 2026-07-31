/**
 * 平台适配器工厂
 *
 * 职责:根据平台标识返回对应的适配器实例,隔离 publish-queue 与具体适配器的依赖
 *       独立成文件避免与 publish-queue / index 形成循环依赖
 */
import type { PublishPlatform, PlatformAdapter } from '../types';
import { DouyinAdapter } from './douyin-adapter';
import { KuaishouAdapter } from './kuaishou-adapter';
import { XiaohongshuAdapter } from './xiaohongshu-adapter';
import { BilibiliAdapter } from './bilibili-adapter';

/** 平台中文名映射(供任务标题与 UI 展示) */
export const PLATFORM_NAMES: Record<PublishPlatform, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
};

/**
 * 适配器工厂:根据平台返回对应适配器实例
 * @param platform 平台标识
 * @returns 平台适配器实例
 */
export function adapterFactory(platform: PublishPlatform): PlatformAdapter {
  switch (platform) {
    case 'douyin':
      return new DouyinAdapter();
    case 'kuaishou':
      return new KuaishouAdapter();
    case 'xiaohongshu':
      return new XiaohongshuAdapter();
    case 'bilibili':
      return new BilibiliAdapter();
    default: {
      const exhaustive: never = platform;
      throw new Error(`不支持的平台: ${String(exhaustive)}`);
    }
  }
}
