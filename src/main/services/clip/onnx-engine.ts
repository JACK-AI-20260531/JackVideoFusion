/**
 * CN-CLIP 双塔 ONNX 真实推理引擎
 *
 * 职责:当 onnxruntime-node 可用且 CN-CLIP 权重存在时,提供真实的中文 CLIP 推理。
 *       任何阶段失败(动态 import / 模型缺失 / 推理异常)都不应导致进程崩溃,
 *       由 factory.ts 降级到 Mock 引擎。
 *
 * 双塔结构(ondevice/cn-clip-onnx):
 *   - 图像塔 visual  : vit-b-16.img.fp32.onnx,输入 [1,3,224,224] float32
 *   - 文本塔 textual : vit-b-16.txt.fp32.onnx,输入 [1,512] int32(中文 wordpiece)
 * 图像预处理:用 ffmpeg 把任意图像/视频帧转为 224x224 RGB raw,直接读为像素。
 * 文本分词:基于 vocab.txt 的中文 wordpiece(cn-tokenizer)。
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { logger } from '../../utils/logger';
import { ffmpegService } from '../ffmpeg';
import { getImageModelPath, getTextModelPath, getVocabPath } from './model-downloader';
import { getCachedTokenizer, CN_TEXT_MAX_LEN } from './cn-tokenizer';
import {
  type Embedding,
  type IClipService,
  type MatchCandidate,
  type MatchResult,
} from './types';
import { normalizeImagePixels, normalizeL2, toFloat32Array, IMAGE_SIZE } from './onnx-utils';

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
  };
  /** 张量构造器 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: { new (type: string, data: any, dims: readonly number[]): OnnxTensorLike };
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
 * 调用 ffmpeg 把任意图像/视频帧转为 224x224 RGB raw 数据
 * @param input 输入文件(图片或视频)
 * @param timeSec 若为视频,指定抽帧时间点;若为 undefined 则当作图片处理
 * @returns 224*224*3 的 RGB 像素 Uint8Array
 */
async function extractRgbPixels(input: string, timeSec?: number): Promise<Uint8Array> {
  const outPath = genTempPath('rgb');
  await ffmpegService.detectBinaries();

  const args: string[] = [];
  if (typeof timeSec === 'number') args.push('-ss', String(timeSec));
  args.push('-i', input);
  if (typeof timeSec === 'number') args.push('-frames:v', '1');
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
 * CN-CLIP 双塔引擎实现
 * 实现完整 IClipService 接口,文本/图像分别经两个 ONNX session 推理。
 */
class CncLlipEngine implements IClipService {
  /** 已加载真实模型标志 */
  public readonly isRealModel = true;
  /** 视觉塔会话(lazy 加载) */
  private imageSession: OnnxSessionLike | null = null;
  /** 文本塔会话(lazy 加载) */
  private textSession: OnnxSessionLike | null = null;
  /** 图像塔模型路径 */
  private readonly imageModelPath: string;
  /** 文本塔模型路径 */
  private readonly textModelPath: string;
  /** onnxruntime-node 模块实例 */
  private readonly onnx: OnnxModuleLike;

  constructor(onnx: OnnxModuleLike, imageModelPath: string, textModelPath: string) {
    this.onnx = onnx;
    this.imageModelPath = imageModelPath;
    this.textModelPath = textModelPath;
  }

  /** 加载视觉塔会话 */
  private async loadImageSession(): Promise<void> {
    if (this.imageSession) return;
    logger.info(`[CLIP] 加载图像塔 ONNX:${this.imageModelPath}`);
    this.imageSession = await this.onnx.InferenceSession.create(this.imageModelPath);
    logger.info(
      `[CLIP] 图像塔加载完成 inputs=${JSON.stringify(this.imageSession.inputNames)}`,
    );
  }

  /** 加载文本塔会话 */
  private async loadTextSession(): Promise<void> {
    if (this.textSession) return;
    logger.info(`[CLIP] 加载文本塔 ONNX:${this.textModelPath}`);
    this.textSession = await this.onnx.InferenceSession.create(this.textModelPath);
    logger.info(
      `[CLIP] 文本塔加载完成 inputs=${JSON.stringify(this.textSession.inputNames)}`,
    );
  }

  /**
   * 加载全部模型与词表
   */
  public async loadModel(): Promise<void> {
    await this.loadImageSession();
    await this.loadTextSession();
    // 预加载词表(纯读文件)
    try {
      const vocabContent = await readFile(await getVocabPath(), 'utf8');
      getCachedTokenizer(vocabContent);
    } catch (err) {
      logger.warn(`[CLIP] 词表加载失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 文本 → 嵌入向量(文本塔)
   * @param text 输入文本
   * @returns 512 维 L2 归一化向量
   */
  public async embedText(text: string): Promise<Embedding> {
    await this.loadTextSession();
    const session = this.textSession as OnnxSessionLike;

    const vocabContent = await readFile(await getVocabPath(), 'utf8');
    const tokenizer = getCachedTokenizer(vocabContent);
    const tokens = tokenizer.encodeToTokens(text ?? '');

    // 自适应输入名:选维度为 2 的输入(序列输入)
    const inputName = this.pickTextInputName(session);
    const feeds: Record<string, OnnxTensorLike> = {
      [inputName]: new this.onnx.Tensor('int32', tokens, [1, CN_TEXT_MAX_LEN]),
    };
    const outputs = await session.run(feeds);
    const outputName = this.pickOutputName(session, 512);
    const arr = toFloat32Array(outputs[outputName].data);
    return normalizeL2(arr);
  }

  /**
   * 图像文件 → 嵌入向量(图像塔)
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
    await this.loadImageSession();
    const session = this.imageSession as OnnxSessionLike;
    const pixels = await extractRgbPixels(input, timeSec);
    const chw = normalizeImagePixels(pixels);

    // 自适应输入名:选维度为 4 的输入(图像张量)
    const inputName = this.pickImageInputName(session);
    const feeds: Record<string, OnnxTensorLike> = {
      [inputName]: new this.onnx.Tensor('float32', chw, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    };
    const outputs = await session.run(feeds);
    const outputName = this.pickOutputName(session, 512);
    const arr = toFloat32Array(outputs[outputName].data);
    return normalizeL2(arr);
  }

  /**
   * 选择文本塔输入名(2 维序列输入)
   */
  private pickTextInputName(session: OnnxSessionLike): string {
    // 优先精确:2D 的输入
    for (const name of session.inputNames) {
      // 无法直接拿 dims,按名字启发式优先 input_ids/input_ids_1 等
      if (/input_ids|text/i.test(name)) return name;
    }
    return session.inputNames[0];
  }

  /**
   * 选择图像塔输入名(4 维图像输入)
   */
  private pickImageInputName(session: OnnxSessionLike): string {
    for (const name of session.inputNames) {
      if (/image|pixel|visual|input$/i.test(name)) return name;
    }
    return session.inputNames[0];
  }

  /**
   * 选择输出名(投影向量输出)
   * @param session 会话
   */
  private pickOutputName(session: OnnxSessionLike, _targetDim: number): string {
    // onnxruntime 无法在 session 层直接读 dims,按惯例取末位输出(logits/image_embedding/text_embedding)
    const names = session.outputNames;
    for (const n of names) {
      if (/embed|image_|text_|pooler/i.test(n)) return n;
    }
    return names[0];
  }

  /**
   * 计算两个向量的余弦相似度(向量已 L2 归一化,点积 = 余弦相似度)
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
   * 批量匹配:文本 vs 多候选项,按分数降序返回
   */
  public async match(
    text: string,
    candidates: MatchCandidate[],
  ): Promise<MatchResult[]> {
    const textVec = await this.embedText(text);
    const results: MatchResult[] = candidates.map((c) => ({
      id: c.id,
      score: this.cosineSimilarity(textVec, c.embedding),
    }));
    results.sort((x, y) => y.score - x.score);
    return results;
  }
}

/**
 * 创建 CN-CLIP 双塔引擎(若模块/模型不可用则返回 null)
 * @param onnxModule onnxruntime-node 模块实例
 * @returns IClipService 实例,或 null 表示降级到 Mock
 */
export async function createOnnxEngine(onnxModule: unknown): Promise<IClipService | null> {
  const onnx = onnxModule as OnnxModuleLike;
  if (!onnx || !onnx.InferenceSession || !onnx.Tensor) {
    logger.warn('[CLIP] onnxruntime-node 模块结构异常,降级到 Mock 引擎');
    return null;
  }

  // 检查模型文件存在(两个塔 + 词表)
  const imageModel = await getImageModelPath();
  const textModel = await getTextModelPath();
  const vocabPath = await getVocabPath();
  try {
    await Promise.all([readFile(imageModel), readFile(textModel), readFile(vocabPath)]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[CLIP] CN-CLIP 模型文件不完整,降级到 Mock 引擎: ${msg}`);
    return null;
  }

  return new CncLlipEngine(onnx, imageModel, textModel);
}
