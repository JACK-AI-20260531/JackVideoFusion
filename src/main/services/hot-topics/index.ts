/**
 * 热点选题服务统一入口
 * 职责:导出 HotTopicService 单例与解析纯函数,供 IPC 层引用
 */
export { hotTopicService, HotTopicService, parseSuggestions } from './topic-service';
export type { TopicSuggestion } from './topic-service';
export { fetchAllTopics, dedupeTopics, fetchTopicSource } from './fetchers';
export type { HotTopicSourceResult } from './fetchers';
