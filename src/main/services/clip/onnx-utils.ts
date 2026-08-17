/**
 * CLIP ONNX 预处理纯函数
 * 职责:文本分词、图像像素归一化、L2 向量归一化、张量数据转换
 *      纯函数,不依赖 electron/ffmpeg/onnx,可独立单元测试
 */

/** CLIP-ViT-B/32 输入图像尺寸 */
export const IMAGE_SIZE = 224;
/** CLIP 文本上下文长度 */
export const TEXT_CONTEXT_LENGTH = 77;
/** CLIP BPE 词表大小(简化假定) */
export const CLIP_VOCAB_SIZE = 49408;
/** CLIP BOS token id */
export const CLIP_BOS_TOKEN = 49406;
/** CLIP EOS token id */
export const CLIP_EOS_TOKEN = 49407;
/** CLIP 图像归一化均值(每个通道,R/G/B) */
export const CLIP_IMAGE_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
/** CLIP 图像归一化标准差(每个通道,R/G/B) */
export const CLIP_IMAGE_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * 简化版 CLIP 文本分词(非精确 BPE)
 * 按字符 codePoint 映射到 [0, vocab_size),加 BOS/EOS,截断/填充到 77。
 * @param text 输入文本
 * @returns 长度为 TEXT_CONTEXT_LENGTH 的 Int32Array token ids
 */
export function simpleTokenize(text: string): Int32Array {
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
export function normalizeImagePixels(rgb: Uint8Array): Float32Array {
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
 * L2 归一化向量
 * @param vec 输入向量
 * @returns 归一化后的 Float32Array(新数组)
 */
export function normalizeL2(vec: Float32Array): Float32Array {
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
 * 从张量数据提取 Float32Array
 * @param data 张量数据
 * @returns Float32Array(若原数据非 Float32Array 则转换)
 */
export function toFloat32Array(data: Float32Array | Int32Array | Uint8Array | number[]): Float32Array {
  if (data instanceof Float32Array) return data;
  return new Float32Array(data);
}
