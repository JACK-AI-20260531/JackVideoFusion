/**
 * CN-CLIP 双塔 ONNX 模型下载器
 *
 * 职责:在应用首次启动时把 CN-CLIP(ondevice/cn-clip-onnx)的图像塔/文本塔 ONNX
 *      权重与中文词表下载到 userData/models/,使 factory 能启用真实双塔推理引擎。
 * 支持:多文件下载、断点续传(Range 请求)、下载进度回调、就绪检测。
 *
 * 模型源:ModelScope ondevice/cn-clip-onnx(中文 CLIP)
 *   - vit-b-16.img.fp32.onnx   图像塔(视觉)
 *   - vit-b-16.txt.fp32.onnx   文本塔(文本,词汇表 21128)
 *   - vocab.txt                中文 wordpiece 词表
 */
import { app } from 'electron';
import { join } from 'path';
import { createWriteStream, existsSync, statSync, mkdirSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import type { IncomingMessage } from 'http';
import { logger } from '../../utils/logger';
import { getConfigService } from '../config-service';

/** 模型文件名约定 */
export const CN_IMAGE_MODEL_FILENAME = 'vit-b-16.img.fp32.onnx';
export const CN_TEXT_MODEL_FILENAME = 'vit-b-16.txt.fp32.onnx';
export const CN_VOCAB_FILENAME = 'vocab.txt';

/**
 * ModelScope 模型直链基址
 * 约定:ModelScope 单文件直链为 {BASE}/{模型名}/{revision}/{路径}
 */
const MODEL_REPO_BASE =
  'https://www.modelscope.cn/models/ondevice/cn-clip-onnx/resolve/master';

/** 需要下载的文件清单: { 远端文件名, 本地文件名 } */
const MODEL_FILES: Array<{ remote: string; local: string }> = [
  { remote: CN_IMAGE_MODEL_FILENAME, local: CN_IMAGE_MODEL_FILENAME },
  { remote: CN_TEXT_MODEL_FILENAME, local: CN_TEXT_MODEL_FILENAME },
  { remote: CN_VOCAB_FILENAME, local: CN_VOCAB_FILENAME },
];

/** 下载进度回调类型 */
export type ModelDownloadProgress = {
  /** 当前文件的已下载字节数 */
  received: number;
  /** 当前文件总字节数(未知时为 -1) */
  total: number;
  /** 当前文件进度百分比 0-100(未知时为 0) */
  percent: number;
  /** 文件名 */
  file: string;
  /** 已完成文件数 */
  completedFiles: number;
  /** 文件总数 */
  totalFiles: number;
};

/** 是否已显式注入测试目录(仅在单元测试中置为 true) */
let dirInjected = false;
/** 测试/自定义模型目录(注入后生效) */
let customModelDir = '';
/** 运行时解析出的模型目录缓存(生产环境,首次解析后复用) */
let runtimeModelDir: string | null = null;

/**
 * 获取运行时模型目录(userData/models 或用户通过配置指定的自定义目录)
 * - 用户配置 clipModelDir 非空时优先使用自定义目录
 * - 否则回退到默认的 userData/models
 * - 测试环境(注入)直接返回注入目录
 * @returns 模型目录绝对路径
 */
export async function getClipModelDir(): Promise<string> {
  if (dirInjected) return customModelDir;
  if (runtimeModelDir) return runtimeModelDir;
  let dir = '';
  try {
    const config = await getConfigService().getConfig();
    dir = config.clipModelDir?.trim() ?? '';
  } catch {
    dir = '';
  }
  if (!dir) {
    const userData = app?.getPath?.('userData') ?? process.cwd();
    dir = join(userData, 'models');
  }
  runtimeModelDir = dir;
  return runtimeModelDir;
}

/**
 * 运行期强制指定模型目录并更新缓存(由 clip IPC 在用户变更目录后调用)
 * @param dir 模型目录绝对路径;传空/无值则重置为读取配置
 */
export function setClipModelDirRuntime(dir: string): void {
  runtimeModelDir = dir && dir.trim() ? dir.trim() : null;
}

/**
 * 注入模型下载目录(仅单元测试使用)
 * 用临时目录替换默认的 userData/models 路径,使下载/就绪逻辑可独立测试
 * @param dir 临时模型目录
 */
export function _setClipModelDirForTest(dir: string): void {
  dirInjected = true;
  customModelDir = dir;
}

/**
 * 恢复为默认模型目录(userData/models),供测试用例间隔离
 */
export function _resetClipModelDirForTest(): void {
  dirInjected = false;
  customModelDir = '';
  runtimeModelDir = null;
}

/**
 * 创建临时测试模型目录(仅测试用),避免用例间互相污染
 * @returns 新创建的临时目录绝对路径
 */
export function _createTestClipModelDir(): string {
  const dir = join(tmpdir(), `jt-clip-models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 检查 CN-CLIP 模型是否已完整就绪(图像塔+文本塔+词表全部存在)
 * @param onProgress 下载进度回调(可选)
 * @returns 是否就绪
 */
export async function isClipModelReady(): Promise<boolean> {
  const dir = await getClipModelDir();
  for (const f of MODEL_FILES) {
    try {
      await fs.access(join(dir, f.local));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 以断点续传方式下载单个文件
 * 若目标已有部分内容且服务器支持 Range,则从已有字节续传。
 * @param url 下载地址
 * @param dest 目标文件路径
 * @param onProgress 进度回调
 */
export function downloadTo(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let received = 0;
    if (existsSync(dest)) {
      try {
        received = statSync(dest).size;
      } catch {
        received = 0;
      }
    }

    const MAX_REDIRECTS = 8;

    const doGet = (
      currentUrl: string,
      redirectCount: number,
    ): void => {
      let mod: typeof httpGet | typeof httpsGet;
      if (currentUrl.startsWith('https://')) mod = httpsGet;
      else if (currentUrl.startsWith('http://')) mod = httpGet;
      else {
        reject(new Error(`模型下载地址协议不支持: ${currentUrl.slice(0, 20)}...`));
        return;
      }

      // ModelScope LFS CDN 对缺少 User-Agent 的请求返回 403,必须携带浏览器 UA
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      };
      if (received > 0) {
        headers.Range = `bytes=${received}-`;
      }

      const req = mod(
        currentUrl,
        {
          // 禁用连接复用:避免 302 响应被继续读取时底层 socket 被复用导致解析错乱
          agent: false,
          headers,
        },
        (res: IncomingMessage) => {
          const code = res.statusCode ?? 0;
          const isRedirect = redirectHandled(code);

          if (isRedirect) {
            res.resume();
            const location = res.headers.location;
            if (!location) {
              reject(new Error(`模型下载重定向缺少 Location: HTTP ${code}`));
              return;
            }
            const nextUrl = new URL(location, currentUrl).toString();
            if (redirectCount >= MAX_REDIRECTS) {
              reject(new Error(`模型下载重定向次数过多(超过 ${MAX_REDIRECTS} 次)`));
              return;
            }
            logger.info(`[CLIP] 模型下载重定向 → ${nextUrl}`);
            doGet(nextUrl, redirectCount + 1);
            return;
          }

          const isRange = code === 206;
          const isOk = code === 200;

          if (!isOk && !isRange) {
            res.resume();
            reject(new Error(`模型下载失败 HTTP ${code}`));
            return;
          }

          const targetReceived = isRange ? received : 0;
          const total = Number(res.headers['content-length'] ?? -1);
          const overallTotal = isRange ? (total >= 0 ? targetReceived + total : -1) : total;

          const out = createWriteStream(dest, { flags: isRange ? 'a' : 'w' });
          let downloaded = targetReceived;

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            onProgress?.(downloaded, overallTotal);
          });
          out.on('error', reject);
          req.on('error', (err) => {
            out.destroy();
            reject(err);
          });
          res.on('error', (err) => {
            out.destroy();
            reject(err);
          });
          res.on('end', () => out.end());
          out.on('finish', resolve);
          res.pipe(out);
        },
      );
      req.on('error', reject);
    };

    doGet(url, 0);
  });
}

/** 判断 HTTP 状态码是否属于重定向(需跟随 Location) */
export function redirectHandled(code: number): boolean {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

/**
 * 确保 CN-CLIP 模型已就绪
 * - 全部文件就绪 → 直接返回 true
 * - 若仅部分缺失 → 补齐缺失文件(已就绪的跳过,支持断点续传)
 * - 下载失败 → 返回 false(不抛出,由 factory 维持 Mock)
 * @param onProgress 下载进度回调(可选)
 * @returns 模型是否就绪
 */
export async function ensureClipModel(
  onProgress?: (p: ModelDownloadProgress) => void,
): Promise<boolean> {
  const dir = await getClipModelDir();

  // 已就绪
  if (await isClipModelReady()) {
    return true;
  }

  // 确保目录存在
  await fs.mkdir(dir, { recursive: true });

  let completedFiles = 0;
  const totalFiles = MODEL_FILES.length;

  for (const item of MODEL_FILES) {
    const dest = join(dir, item.local);
    try {
      await fs.access(dest);
      completedFiles += 1;
      continue;
    } catch {
      // 文件缺失,需要下载
    }

    const url = `${MODEL_REPO_BASE}/${item.remote}`;
    logger.info(`[CLIP] 开始下载模型文件: ${item.local} ← ${url}`);
    try {
      await downloadTo(url, dest, (received, total) => {
        onProgress?.({
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
          file: item.local,
          completedFiles,
          totalFiles,
        });
      });
      completedFiles += 1;
      logger.info(`[CLIP] 模型文件下载完成: ${item.local}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[CLIP] 模型文件下载失败: ${item.local}: ${msg}`);
      // 清理半成品,避免误判
      await fs.rm(dest, { force: true }).catch(() => {});
      return false;
    }
  }

  return await isClipModelReady();
}

/** 导出模型文件路径获取(供引擎读取) */
export async function getImageModelPath(): Promise<string> {
  return join(await getClipModelDir(), CN_IMAGE_MODEL_FILENAME);
}
export async function getTextModelPath(): Promise<string> {
  return join(await getClipModelDir(), CN_TEXT_MODEL_FILENAME);
}
export async function getVocabPath(): Promise<string> {
  return join(await getClipModelDir(), CN_VOCAB_FILENAME);
}
