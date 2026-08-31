/**
 * 自动发布服务统一入口
 *
 * 职责:
 *   - 集中导出 publishQueue / browserManager / authStore 单例
 *   - 重新导出适配器工厂(adapterFactory)与所有类型
 *   - 供 IPC 层与渲染层统一引用
 */
export { publishQueue } from './publish-queue';
export { browserManager } from './browser-manager';
export { authStore } from './auth-store';
export { scheduleStore, classifySchedule, canTransition, staggerTimes } from './schedule-store';
export type { ScheduledEntry, ScheduleStatus, ScheduleClass, ScheduleStore } from './schedule-store';
export { analyticsStore, parseCount, parseStatsFromTexts } from './analytics-store';
export type { AnalyticsRecord, AnalyticsStore } from './analytics-store';
export { generateCover, pickFrameTimes, truncateCoverText, buildCoverPath, findChineseFontFile } from './cover';
export { adapterFactory, PLATFORM_NAMES } from './adapters';
export type { BasePlatformAdapter } from './adapters/base-adapter';

export type {
  PublishPlatform,
  LoginStatus,
  AccountInfo,
  PublishParams,
  PublishTask,
  PublishTaskStatus,
  PublishResult,
  PlatformAdapter,
  BrowserContextConfig,
  ProgressCallback,
} from './types';
