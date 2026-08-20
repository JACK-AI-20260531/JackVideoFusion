/**
 * OCR 语言包管理与本地化
 *
 * 职责:管理 Tesseract.js 语言包(如 chi_sim/eng)的下载与本地缓存,
 *      使 OCR 引擎无需依赖 tesseract.js 内部缓存机制,可离线复用。
 *
 * 存储位置:userData/ocr-data/{lang}.traineddata.gz
 * 下载源:cdn.jsdelivr.net @tesseract.js-data {lang} 4.0.0_best_int
 *
 * 设计约定:
 *   - 复用 userData/ocr-data 作为持久化目录,避免向只读安装目录写文件
 *   - 目录可注入(便于单元测试),默认取 app.getPath('userData')
 *   - 已存在语言包文件则直接复用,不重复下载
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { get as httpsGet } from 'https';
import { logger } from '../../utils/logger';
import type { OcrLang } from './types';

/** 语言包下载基址(tesseract.js-data best_int LSTM 模型) */
const LANG_BASE =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int/{lang}.traineddata.gz';

/** 是否已注入测试目录 */
let dirInjected = false;
/** 测试/自定义语言包目录 */
let customDir = '';

/**
 * 获取 OCR 数据目录(userData/ocr-data)
 * 测试环境可通过 _setOcrDataDirForTest 覆盖
 * @returns 数据目录绝对路径
 */
export function getOcrDataDir(): string {
  if (dirInjected) return customDir;
  const userData = app?.getPath?.('userData') ?? process.cwd();
  return join(userData, 'ocr-data');
}

/**
 * 注入 OCR 数据目录(仅单元测试使用)
 * @param dir 临时数据目录
 */
export function _setOcrDataDirForTest(dir: string): void {
  dirInjected = true;
  customDir = dir;
}

/**
 * 恢复默认 OCR 数据目录
 */
export function _resetOcrDataDirForTest(): void {
  dirInjected = false;
  customDir = '';
}

/**
 * 创建临时 OCR 数据目录(仅测试用)
 * @returns 新目录绝对路径
 */
export function _createTestOcrDataDir(): string {
  const dir = join(tmpdir(), `jt-ocr-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取指定语言的本地语言包文件路径
 * @param lang 语言
 * @returns 语言包文件(gz)绝对路径
 */
export function langPackPath(lang: OcrLang): string {
  return join(getOcrDataDir(), `${lang}.traineddata.gz`);
}

/**
 * 检查指定语言的语言包是否已就绪
 * @param lang 语言
 * @returns 是否已存在语言包文件
 */
export async function isLangReady(lang: OcrLang): Promise<boolean> {
  try {
    await fs.access(langPackPath(lang));
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载单个语言包文件到本地
 * @param lang 语言
 * @returns 语言包文件(gz)路径
 */
async function downloadLang(lang: OcrLang): Promise<string> {
  const url = LANG_BASE.replaceAll('{lang}', lang);
  const dest = langPackPath(lang);
  await fs.mkdir(getOcrDataDir(), { recursive: true });
  logger.info(`[OCR] 下载语言包: ${lang} ← ${url}`);

  await new Promise<void>((resolve, reject) => {
    httpsGet(url, (res) => {
      const code = res.statusCode ?? 0;
      if (code !== 200) {
        res.resume();
        reject(new Error(`语言包下载失败 HTTP ${code}: ${lang}`));
        return;
      }
      const out = createWriteStream(dest);
      res.on('error', (err) => {
        out.destroy();
        reject(err);
      });
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    }).on('error', reject);
  });

  logger.info(`[OCR] 语言包下载完成: ${lang}`);
  return dest;
}

/**
 * 确保语言包就绪(缺失则下载),返回本地语言包目录
 * @param lang 语言
 * @returns OCR 数据目录(engine 用 langPath 指向它)
 */
export async function ensureLangReady(lang: OcrLang): Promise<string> {
  if (!(await isLangReady(lang))) {
    await downloadLang(lang);
  }
  return getOcrDataDir();
}

/**
 * 保证语言包文件存在,供 build 时是否自带等场景使用
 * @param lang 语言
 * @returns 是否就绪
 */
export async function checkLangReadySafe(lang: OcrLang): Promise<boolean> {
  try {
    return await isLangReady(lang);
  } catch {
    return false;
  }
}
