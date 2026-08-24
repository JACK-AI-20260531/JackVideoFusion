/**
 * OCR 引擎封装(Tesseract.js WASM)
 *
 * 职责:封装 Tesseract.js 的 worker 生命周期与单图识别,隐藏语言包下载、
 *      worker 创建/回收等细节。
 *
 * 特性:
 *   - lazy 创建 worker(首次识别前初始化,复用单一 worker)
 *   - 语言包(chi_sim/eng)由 lang-store 提供本地目录,首次自动下载后离线复用
 *   - terminate 释放 worker 资源
 *
 * 设计约定:
 *   - TesseractOcrEngine 实现 OcrEngine 接口,便于测试注入 mock 识别器
 *   - 依赖 tesseract.js(WASM),本地推理,不依赖系统 OCR
 */
import { createWorker, type Worker } from 'tesseract.js';
import { logger } from '../../utils/logger';
import type { OcrLang } from './types';

/** OCR 引擎接口(便于测试注入替代实现) */
export interface OcrEngine {
  /** 确保引擎就绪(懒加载 worker),识别前必须调用 */
  ensureReady(): Promise<void>;
  /** 识别单张图片,返回清洗后文本 */
  recognize(imagePath: string): Promise<string>;
  /** 释放引擎资源 */
  terminate(): Promise<void>;
}

/** 可注入的工厂类型(测试用),返回识别图片文本的函数 */
export type RecognizeFn = (imagePath: string) => Promise<string>;

/** 默认 OCR 语言包 */
const DEFAULT_LANG: OcrLang = 'chi_sim';

/**
 * 基于 Tesseract.js 的真实 OCR 引擎
 */
export class TesseractOcrEngine implements OcrEngine {
  private worker: Worker | null = null;
  private readonly lang: string;
  private readonly langPath?: string;

  /**
   * @param lang OCR 语言(任意 Tesseract 语言码,如 chi_sim / eng),默认 chi_sim
   * @param langPath 本地语言包目录(含 {lang}.traineddata.gz),由 lang-store 提供
   */
  constructor(lang: string = DEFAULT_LANG, langPath?: string) {
    this.lang = lang;
    this.langPath = langPath;
  }

  /**
   * 懒创建 worker(若未创建)
   */
  async ensureReady(): Promise<void> {
    if (this.worker) return;
    logger.info(`[OCR] 初始化 Tesseract worker(lang=${this.lang})...`);
    // langPath 指向 lang-store 缓存的本地语言包;cacheMethod='none' 使其
    // 直接从本地文件读取 .traineddata.gz,绕开 tesseract.js 内部 cwd 缓存
    this.worker = await createWorker(this.lang, 1, {
      gzip: true,
      cacheMethod: 'none',
      langPath: this.langPath,
    });
    logger.info(`[OCR] Tesseract worker 就绪(lang=${this.lang})`);
  }

  /**
   * 识别单张图片
   * @param imagePath 图片绝对路径(png/jpg 等)
   * @returns 识别出的文本(未清洗,由上层归一化)
   */
  async recognize(imagePath: string): Promise<string> {
    await this.ensureReady();
    const { data } = await (this.worker as Worker).recognize(imagePath);
    return data.text;
  }

  /**
   * 释放 worker 资源
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      await w.terminate();
      logger.info(`[OCR] Tesseract worker 已回收`);
    }
  }
}

/**
 * 创建一个以注入识别函数驱动的引擎(测试/Mock 用)
 * @param fn 识别函数(输入图片路径,输出文本)
 * @returns OcrEngine 实例
 */
export function createMockOcrEngine(fn: RecognizeFn): OcrEngine {
  let ready = false;
  return {
    async ensureReady() {
      ready = true;
    },
    async recognize(imagePath: string) {
      if (!ready) {
        throw new Error('OCR 引擎未就绪');
      }
      return fn(imagePath);
    },
    async terminate() {
      ready = false;
    },
  };
}
