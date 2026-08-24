/**
 * ASR 模型目录管理
 *
 * 职责:管理 Whisper ONNX 模型在本地 userData 的缓存目录,使 @huggingface/transformers
 *      优先从本地缓存加载,首次下载后离线复用。
 *
 * 存储位置:userData/models/asr
 * 模型由 transformers 内部下载到该目录(env.cacheDir),目录可注入便于测试。
 *
 * 设计约定:
 *   - 复用 userData/models/asr 作为持久化目录,避免向只读安装目录写文件
 *   - 目录可注入(便于单元测试),默认取 app.getPath('userData')
 *   - 就绪检测:检查缓存目录是否存在对应模型的子目录(文件名含模型近名)
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { logger } from '../../utils/logger';
import type { AsrModelSize } from './types';

/** 模型规格 → 模型名片段(用于就绪检测匹配本地缓存子目录) */
const MODEL_DIR_FRAGMENT: Record<AsrModelSize, string> = {
  base: 'whisper-base',
  small: 'whisper-small',
  medium: 'whisper-medium',
};

/** 是否已注入测试目录 */
let dirInjected = false;
/** 测试/自定义模型目录 */
let customDir = '';

/**
 * 获取 ASR 模型缓存目录(userData/models/asr)
 * 测试环境可通过 _setAsrModelDirForTest 覆盖
 * @returns 模型目录绝对路径
 */
export function getAsrModelDir(): string {
  if (dirInjected) return customDir;
  const userData = app?.getPath?.('userData') ?? process.cwd();
  return join(userData, 'models', 'asr');
}

/**
 * 注入 ASR 模型目录(仅单元测试使用)
 * @param dir 临时模型目录
 */
export function _setAsrModelDirForTest(dir: string): void {
  dirInjected = true;
  customDir = dir;
}

/**
 * 恢复默认 ASR 模型目录
 */
export function _resetAsrModelDirForTest(): void {
  dirInjected = false;
  customDir = '';
}

/**
 * 创建临时 ASR 模型目录(仅测试用)
 * @returns 新目录绝对路径
 */
export function _createTestAsrModelDir(): string {
  const dir = join(tmpdir(), `jt-asr-models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 检查指定模型规格是否已在本地缓存就绪
 * transformers 缓存子目录名为 models--{org}--{model},此处按模型名片段模糊匹配
 * @param modelSize 模型规格
 * @returns 是否就绪
 */
export async function isAsrModelReady(modelSize: AsrModelSize = 'base'): Promise<boolean> {
  const dir = getAsrModelDir();
  const fragment = MODEL_DIR_FRAGMENT[modelSize];
  try {
    const entries = await fs.readdir(dir);
    return entries.some((e) => e.includes(fragment));
  } catch {
    // 目录不存在或无法读取 → 视为未就绪
    return false;
  }
}

/**
 * 确保 ASR 模型目录存在并返回(transformers 会下载模型到该目录)
 * @returns 模型目录绝对路径
 */
export function ensureAsrModelDir(): string {
  const dir = getAsrModelDir();
  mkdirSync(dir, { recursive: true });
  logger.info(`[ASR] 模型目录: ${dir}`);
  return dir;
}
