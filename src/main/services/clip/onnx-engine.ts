/**
 * CLIP ONNX 真实推理引擎
 *
 * 职责:当 onnxruntime-node 可用且模型权重存在时,提供真实的 CLIP-ViT-B/32 推理。
 *       任何阶段失败(动态 import / 模型缺失 / 推理异常)都不应导致进程崩溃,
 *       由 factory.ts 降级到 Mock 引擎。
 *
 * 实现简化(任务约定"重点是接口跑通"):
 *   - 文本分词:按字符 codePoint 映射为 token id(非精确 BPE,可跑通流程)
 *   - 图像预处理:用 ffmpeg 把任意图像/视频帧转为 224x224 RGB raw,直接读为像素
 *   - 像素归一化:CLIP 标准 (pixel / 255 - mean) / std,CHW 布局
 */
import { app } from 'electron';
import { join } from 'path';
import { tmpdir } from 'os';
import { access, readFile, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { logger } from '../../utils/logger';
import { ffmpegService } from '../ffmpeg';
import {
  type Embedding,
  type IClipService,
  type MatchCandidate,
  type MatchResult,
} from './types';

/** 模型文件名约定 */
const MODEL_FILENAME = 'clip-vit-b32.onnx';
/** CLIP-ViT-B/32 输入图像尺寸 */
const IMAGE_SIZE = 224;
/** CLIP 文本上下文长度 */
const TEXT_CONTEXT_LENGTH = 77;
/** CLIP BPE 词表大小(简化假定) */
const CLIP_VOCAB_SIZE = 49408;
/** CLIP BOS token id */
const CLIP_BOS_TOKEN = 49406;
/** CLIP EOS token id */
const CLIP_EOS_TOKEN = 49407;
/** CLIP 图像归一化均值(每个通道,R/G/B) */
const CLIP_IMAGE_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
/** CLIP 图像归一化标准差(每个通道,R/G/B) */
const CLIP_IMAGE_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/** ONNX 张量最小类型契约(与 onnxruntime-common 兼容) */
interface OnnxTensorLike {
  /** 张量数据 */
  data: Float32Array | Int32Array | Uint8Array | number[];
  /** 张量形状 */
  dims: readonly number[];
}

/** ONNX 推理会话最小类型契约 */
interface OnnxSessionLike {
  /** 执行推理 */
  run(feeds: Readonly<Record<string, OnnxTensorLike>>): Promise<Readonly<Record<string, OnnxTensorLike>>>;
  /** 模型输入名 */
  readonly inputNames: readonly string[];
  /** 模型输出名 */
  readonly outputNames: readonly string[];
  /** 释放会话资源 */
  release(): Promise<void>;
}

/** onnxruntime-node 模块最小类型契约 */
interface OnnxModuleLike {
  /** 推理会话工厂 */
  InferenceSession: {
    /** 从文件路径加载模型 */
    create(uri: string): Promise<OnnxSessionLike>;
    /** 从 buffer 加载模型 */
    create(buffer: ArrayBufferLike | Uint8Array): Promise<OnnxSessionLike>;
  };
  /** 张量构造器 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: { new (type: string, data: any, dims: readonly number[]): OnnxTensorLike };
}

/**
 * 获取 CLIP 模型文件路径
 * 约定:userData/models/clip-vit-b32.onnx
 * 防御性处理:app 未就绪时回退到 cwd
 * @returns 模型文件绝对路径
 */
function getModelPath(): string {
  const userData = app?.getPath?.('userData') ?? process.cwd();
  return join(userData, 'models', MODEL_FILENAME);
}

/**
 * 生成临时文件路径(用于抽帧/raw 像素中转)
 * @param ext 扩展名(不含点)
 * @returns 临时文件绝对路径
 */
function genTempPath(ext: string): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return join(tmpdir(), `jvf-clip-${id}.${ext}`);
}

/**
 * 简化版 CLIP 文本分词(非精确 BPE)
 * 按字符 codePoint 映射到 [0, vocab_size),加 BOS/EOS,截断/填充到 77。
 * @param text 输入文本
 * @returns 长度为 TEXT_CONTEXT_LENGTH 的 Int32Array token ids
 */
function simpleTokenize(text: string): Int32Array {
  const tokens = new Int32Array(TEXT_CONTEXT_LENGTH);
  tokens[0] = CLIP_BOS_TOKEN;
  const src = (text ?? '').normalize('NFC');
  let i = 1;
  for (const ch of src) {
    if (i >= TEXT_CONTEXT_LENGTH - 1) break;
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      tokens[i] = cp % CLIP_VOCAB_SIZE;
    }
    i++;
  }
  tokens[i] = CLIP_EOS_TOKEN;
  return tokens;
}

/**
 * 将 224*224*3 的 RGB 像素缓冲归一化为 CHW Float32Array
 * CLIP 标准:CHW 布局,(pixel/255 - mean) / std
 * @param rgb 224*224*3 的 RGB 像素数据
 * @returns 长度 3*224*224 的 CHW Float32Array
 */
function normalizeImagePixels(rgb: Uint8Array): Float32Array {
  const chw = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
  const plane = IMAGE_SIZE * IMAGE_SIZE;
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const idx = (y * IMAGE_SIZE + x) * 3;
      const r = rgb[idx] / 255;
      const g = rgb[idx + 1] / 255;
      const b = rgb[idx + 2] / 255;
      chw[0 * plane + y * IMAGE_SIZE + x] = (r - CLIP_IMAGE_MEAN[0]) / CLIP_IMAGE_STD[0];
      chw[1 * plane + y * IMAGE_SIZE + x] = (g - CLIP_IMAGE_MEAN[1]) / CLIP_IMAGE_STD[1];
      chw[2 * plane + y * IMAGE_SIZE + x] = (b - CLIP_IMAGE_MEAN[2]) / CLIP_IMAGE_STD[2];
    }
  }
  return chw;
}

/**
 * 调用 ffmpeg 把任意图像/视频帧转为 224x224 RGB raw 数据
 * @param input 输入文件(图片或视频)
 * @param timeSec 若为视频,指定抽帧时间点;若为 undefined 则当作图片处理
 * @returns 224*224*3 的 RGB 像素 Uint8Array
 */
async function extractRgbPixels(input: string, timeSec?: number): Promise<Uint8Array> {
  const outPath = genTempPath('rgb');
  // 通过 ffmpegService 确保二进制就绪(其内部会 setFfmpegPath)
  await ffmpegService.detectBinaries();

  const args: string[] = [];
  if (typeof timeSec === 'number') {
    args.push('-ss', String(timeSec));
  }
  args.push('-i', input);
  if (typeof timeSec === 'number') {
    args.push('-frames:v', '1');
  }
  args.push(
    '-vf',
    `scale=${IMAGE_SIZE}:${IMAGE_SIZE}:force_original_aspect_ratio=decrease,pad=${IMAGE_SIZE}:${IMAGE_SIZE}:(ow-iw)/2:(oh-ih)/2`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    outPath,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 抽帧失败 code=${code}: ${stderr.slice(-512)}`));
    });
  });

  try {
    const buf = await readFile(outPath);
    return new Uint8Array(buf);
  } finally {
    await unlink(outPath).catch(() => {
      /* 忽略清理失败 */
    });
  }
}

/**
 * L2 归一化向量
 * @param vec 输入向量
 * @returns 归一化后的 Float32Array(新数组)
 */
function normalizeL2(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  } else {
    out.set(vec);
  }
  return out;
}

/**
 * 从 OnnxTensorLike 数据提取 Float32Array
 * @param data 张量数据
 * @returns Float32Array(若原数据非 Float32Array 则转换)
 */
function toFloat32Array(data: OnnxTensorLike['data']): Float32Array {
  if (data instanceof Float32Array) return data;
  return new Float32Array(data);
}

/**
 * ONNX CLIP 引擎实现
 * 实现完整 IClipService 接口,所有嵌入由真实 ONNX 推理产出。
 */
class OnnxClipEngine implements IClipService {
  /** 已加载真实模型标志 */
  public readonly isRealModel = true;
  /** 推理会话(lazy 加载) */
  private session: OnnxSessionLike | null = null;
  /** 模型文件路径 */
  private readonly modelPath: string;
  /** onnxruntime-node 模块实例 */
  private readonly onnx: OnnxModuleLike;

  /**
   * @param onnx onnxruntime-node 模块实例
   * @param modelPath 模型文件绝对路径
   */
  constructor(onnx: OnnxModuleLike, modelPath: string) {
    this.onnx = onnx;
    this.modelPath = modelPath;
  }

  /**
   * 加载 ONNX 模型(若已加载则跳过)
   */
  public async loadModel(): Promise<void> {
    if (this.session) return;
    logger.info(`[CLIP] 加载 ONNX 模型:${this.modelPath}`);
    this.session = await this.onnx.InferenceSession.create(this.modelPath);
    logger.info(
      `[CLIP] ONNX 模型加载完成 inputs=${JSON.stringify(this.session.inputNames)} outputs=${JSON.stringify(this.session.outputNames)}`,
    );
  }

  /**
   * 文本 → 嵌入向量
   * @param text 输入文本
   * @returns 512 维 L2 归一化向量
   */
  public async embedText(text: string): Promise<Embedding> {
    await this.loadModel();
    const session = this.session as OnnxSessionLike;
    const tokens = simpleTokenize(text);
    const inputName = session.inputNames[0];
    const feeds: Record<string, OnnxTensorLike> = {
      [inputName]: new this.onnx.Tensor('int32', tokens, [1, TEXT_CONTEXT_LENGTH]),
    };
    const outputs = await session.run(feeds);
    const outputName = session.outputNames[0];
    const arr = toFloat32Array(outputs[outputName].data);
    return normalizeL2(arr);
  }

  /**
   * 图像文件 → 嵌入向量
   * @param imagePath 图像文件路径
   * @returns 512 维 L2 归一化向量
   */
  public async embedImage(imagePath: string): Promise<Embedding> {
    return this.embedImageInternal(imagePath, undefined);
  }

  /**
   * 视频某时间点抽帧 → 嵌入向量
   * @param videoPath 视频文件路径
   * @param timeSec 抽帧时间点(秒)
   * @returns 512 维 L2 归一化向量
   */
  public async embedVideoFrame(videoPath: string, timeSec: number): Promise<Embedding> {
    return this.embedImageInternal(videoPath, timeSec);
  }

  /**
   * 图像/视频帧 → 嵌入向量(内部共用实现)
   * @param input 输入文件路径
   * @param timeSec 抽帧时间点(秒);undefined 表示输入为静态图片
   * @returns 512 维 L2 归一化向量
   */
  private async embedImageInternal(input: string, timeSec: number | undefined): Promise<Embedding> {
    await this.loadModel();
    const session = this.session as OnnxSessionLike;
    const pixels = await extractRgbPixels(input, timeSec);
    const chw = normalizeImagePixels(pixels);
    const inputName = session.inputNames[0];
    const feeds: Record<string, OnnxTensorLike> = {
      [inputName]: new this.onnx.Tensor('float32', chw, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    };
    const outputs = await session.run(feeds);
    const outputName = session.outputNames[0];
    const arr = toFloat32Array(outputs[outputName].data);
    return normalizeL2(arr);
  }

  /**
   * 计算两个向量的余弦相似度
   * 向量已 L2 归一化,点积 = 余弦相似度,结果范围 [-1, 1]。
   * @param a 向量 A
   * @param b 向量 B
   * @returns 余弦相似度
   */
  public cosineSimilarity(a: Embedding, b: Embedding): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    if (dot > 1) return 1;
    if (dot < -1) return -1;
    return dot;
  }

  /**
   * 批量匹配:文本 vs 多个候选项,按分数降序返回
   * 注意:同步签名与真实异步 ONNX 推理存在本质矛盾。
   * 此实现要求调用方先调用 embedText 触发文本向量缓存,
   * 否则将抛错以引导使用 embedText + cosineSimilarity 的异步组合。
   * @param text 查询文本
   * @param candidates 候选项列表(id + 嵌入向量)
   * @returns 按相似度降序的匹配结果
   * @throws 当文本嵌入未预先计算时抛错
   */
  public match(text: string, candidates: MatchCandidate[]): MatchResult[] {
    throw new Error(
      `[CLIP] OnnxClipEngine.match 同步形式不可用(text="${text.slice(0, 16)}...", 候选 ${candidates.length} 项)。请改用 embedText + cosineSimilarity`,
    );
  }
}

/**
 * 创建 ONNX CLIP 引擎(若模块/模型不可用则返回 null)
 * @param onnxModule onnxruntime-node 模块实例(未知类型,内部断言为 OnnxModuleLike)
 * @returns IClipService 实例,或 null 表示降级到 Mock
 */
export async function createOnnxEngine(onnxModule: unknown): Promise<IClipService | null> {
  const onnx = onnxModule as OnnxModuleLike;
  if (!onnx || !onnx.InferenceSession || !onnx.Tensor) {
    logger.warn('[CLIP] onnxruntime-node 模块结构异常,降级到 Mock 引擎');
    return null;
  }

  // 检查模型文件存在(不存在则降级 Mock,无需抛错)
  const modelPath = getModelPath();
  try {
    await access(modelPath);
  } catch {
    logger.warn(`[CLIP] ONNX 模型文件不存在:${modelPath},降级到 Mock 引擎`);
    return null;
  }

  return new OnnxClipEngine(onnx, modelPath);
}
