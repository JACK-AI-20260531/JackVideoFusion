/**
 * CLIP 服务 IPC 注册
 *
 * 职责:将 IClipService 的能力暴露为 clip:* 系列 IPC 通道,
 *       供渲染层通过 ipcRenderer.invoke('clip:xxx', payload) 调用。
 *
 * 通道列表:
 *   clip:status    - 查询引擎状态(真实/Mock、是否已加载)
 *   clip:loadModel - 触发模型加载(真实引擎有效,Mock 空操作)
 *   clip:embedText - 文本 → 嵌入向量(返回 number[],IPC 传输友好)
 *   clip:match     - 文本 vs 多候选项批量匹配(返回降序 MatchResult[])
 *
 * 集成说明:本文件 export 的 register 函数需在 electron/ipc/index.ts
 *           的 registerAllIpc 中追加调用(集成阶段统一处理,本文件不修改该入口)。
 *
 * 数据序列化:
 *   Embedding(Float32Array)在 IPC 边界转为 number[],接收方按需转回 Float32Array。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { getClipService } from '../services/clip';
import type { Embedding, MatchCandidate, MatchResult } from '../services/clip';

/** clip:status 返回结构 */
interface ClipStatusPayload {
  /** 是否已加载真实 ONNX 模型(否则为 Mock) */
  isRealModel: boolean;
  /** 模型是否已加载完成(真实引擎加载完毕;Mock 视为已加载) */
  modelLoaded: boolean;
}

/** clip:embedText 请求载荷 */
interface EmbedTextPayload {
  /** 输入文本 */
  text: string;
}

/** clip:match 请求载荷 */
interface MatchPayload {
  /** 查询文本 */
  text: string;
  /** 候选项列表(id + embedding[number[]]) */
  candidates: Array<{ id: string; embedding: number[] }>;
}

/** clip:match 单个候选项(embedding 为 number[] 形式,IPC 入参) */
interface RawCandidate {
  /** 候选项 id */
  id: string;
  /** 嵌入向量(普通数组形式,IPC 传输) */
  embedding: number[];
}

/** 已加载服务与状态缓存(进程内单例) */
let cachedService: Awaited<ReturnType<typeof getClipService>> | null = null;
let modelLoadedFlag = false;

/**
 * 获取 CLIP 服务实例并缓存
 * 首次调用触发工厂创建,后续复用。
 * @returns CLIP 服务实例
 */
async function getService(): Promise<NonNullable<typeof cachedService>> {
  if (!cachedService) {
    cachedService = await getClipService();
  }
  return cachedService;
}

/**
 * 将 Float32Array 嵌入向量转为 number[](IPC 传输友好)
 * @param vec 嵌入向量
 * @returns number[] 形式
 */
function embeddingToNumbers(vec: Embedding): number[] {
  return Array.from(vec);
}

/**
 * 将 number[] 转回 Float32Array
 * @param nums number[] 形式的嵌入向量
 * @returns Float32Array
 */
function numbersToEmbedding(nums: number[]): Embedding {
  return new Float32Array(nums);
}

/**
 * 注册 CLIP 服务 IPC handlers
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 查询 CLIP 引擎状态
   * 返回: { isRealModel: boolean, modelLoaded: boolean }
   */
  safeHandle(ipc, 'clip:status', async () => {
    const service = await getService();
    const status: ClipStatusPayload = {
      isRealModel: service.isRealModel,
      modelLoaded: modelLoadedFlag,
    };
    return status;
  });

  /**
   * 触发模型加载
   * 真实引擎会加载 ONNX 模型;Mock 引擎空操作。
   * 返回: { isRealModel: boolean }
   */
  safeHandle(ipc, 'clip:loadModel', async () => {
    const service = await getService();
    await service.loadModel();
    modelLoadedFlag = true;
    return { isRealModel: service.isRealModel };
  });

  /**
   * 文本 → 嵌入向量
   * payload: { text: string }
   * 返回: number[](512 维)
   */
  safeHandle(ipc, 'clip:embedText', async (_event, payload) => {
    const p = payload as EmbedTextPayload;
    if (!p || typeof p.text !== 'string') {
      throw new Error('clip:embedText 参数无效:缺少 text 字段');
    }
    const service = await getService();
    const vec = await service.embedText(p.text);
    return embeddingToNumbers(vec);
  });

  /**
   * 批量匹配:文本 vs 多个候选项
   * payload: { text: string, candidates: [{ id, embedding: number[] }] }
   * 返回: MatchResult[](按相似度降序)
   */
  safeHandle(ipc, 'clip:match', async (_event, payload) => {
    const p = payload as MatchPayload;
    if (!p || typeof p.text !== 'string' || !Array.isArray(p.candidates)) {
      throw new Error('clip:match 参数无效:期望 { text, candidates: [] }');
    }
    const service = await getService();
    const candidates: MatchCandidate[] = (p.candidates as RawCandidate[]).map((c) => ({
      id: c.id,
      embedding: numbersToEmbedding(c.embedding),
    }));
    const results: MatchResult[] = await service.match(p.text, candidates);
    return results;
  });
}

/** 导出类型供渲染层 preload 复用 */
export type { ClipStatusPayload, EmbedTextPayload, MatchPayload, MatchResult };
