/**
 * CLIP 服务类型定义
 *
 * 职责:声明 CLIP 视觉语义推理服务的抽象接口 IClipService,
 *       供 Mock 引擎与 ONNX 真实引擎共同实现,实现"接口优先,降级兼容"。
 *
 * 设计约定:
 *   - 嵌入向量维度固定 512(CLIP-ViT-B/32 标准)
 *   - 所有引擎返回的向量已 L2 归一化,余弦相似度=点积
 *   - 通过 IPC 传输时,Embedding 需转为 number[] 序列化
 */

/** 嵌入向量(512 维,CLIP-ViT-B/32 标准) */
export type Embedding = Float32Array;

/** 匹配结果项 */
export interface MatchResult {
  /** 素材/帧的标识(文件路径或帧时间戳) */
  id: string;
  /** 余弦相似度 [-1, 1] */
  score: number;
}

/** 候选项:携带自身嵌入向量的素材/帧 */
export interface MatchCandidate {
  /** 素材/帧的标识 */
  id: string;
  /** 候选项嵌入向量(已 L2 归一化) */
  embedding: Embedding;
}

/**
 * CLIP 服务抽象接口
 * 实现方:MockClipEngine(伪向量)/ OnnxClipEngine(真实推理)
 */
export interface IClipService {
  /** 是否已加载真实模型(否则为 mock) */
  readonly isRealModel: boolean;
  /** 加载模型(若用 mock 则空操作) */
  loadModel(): Promise<void>;
  /** 文本 → 嵌入向量 */
  embedText(text: string): Promise<Embedding>;
  /** 图像文件 → 嵌入向量(内部用 ffmpeg 抽帧再推理) */
  embedImage(imagePath: string): Promise<Embedding>;
  /** 视频某时间点抽帧 → 嵌入向量 */
  embedVideoFrame(videoPath: string, timeSec: number): Promise<Embedding>;
  /** 计算两个向量的余弦相似度 */
  cosineSimilarity(a: Embedding, b: Embedding): number;
  /** 批量匹配:文本 vs 多个图像向量,返回按分数降序的结果 */
  match(text: string, candidates: MatchCandidate[]): MatchResult[];
}

/** CLIP-ViT-B/32 嵌入维度 */
export const CLIP_EMBEDDING_DIM = 512;
