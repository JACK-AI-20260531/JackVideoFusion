/**
 * CLIP 服务入口
 *
 * 职责:导出 CLIP 服务单例(懒加载)与公共类型,供 IPC 层与上层模块调用。
 *
 * 使用方式:
 *   const clip = await getClipService();
 *   const textVec = await clip.embedText('猫咪');
 *   const imgVec = await clip.embedImage('/path/to/frame.png');
 *   const score = clip.cosineSimilarity(textVec, imgVec);
 */
import { createClipService } from './factory';
import type { IClipService } from './types';

export { createClipService } from './factory';
export type {
  Embedding,
  IClipService,
  MatchCandidate,
  MatchResult,
} from './types';
export { CLIP_EMBEDDING_DIM } from './types';

/** CLIP 服务实例 Promise 缓存(懒加载,首次调用触发工厂创建) */
let clipServicePromise: Promise<IClipService> | null = null;

/**
 * 获取 CLIP 服务单例(懒加载)
 * 首次调用触发 createClipService 工厂,后续复用同一 Promise。
 * @returns IClipService 实例(真实 ONNX 引擎或 Mock 引擎)
 */
export async function getClipService(): Promise<IClipService> {
  if (!clipServicePromise) {
    clipServicePromise = createClipService();
  }
  return clipServicePromise;
}
