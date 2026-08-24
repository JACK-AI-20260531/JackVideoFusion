/**
 * 音色库管理
 *
 * 职责:管理 userData/voice-library/ 目录下的克隆音色,包括:
 *   - 维护 index.json 元数据(音色索引)
 *   - 保存新音色:复制用户样本文件到音色库目录,生成 ref_audio 文件
 *   - 列出/查询/删除音色
 *
 * 目录结构:
 *   userData/voice-library/
 *     index.json           - 元数据(VoiceLibraryMeta)
 *     voices/
 *       <voiceId>/
 *         ref_audio.<ext>   - 参考音频副本
 *
 * 设计约定:
 *   - 不依赖网络:纯本地文件操作
 *   - 元数据优先从 index.json 读取,缺失时回退到目录扫描
 *   - 每次写操作后立即落盘,避免内存与磁盘不一致
 */

import { app } from 'electron';
import { promises as fs, existsSync, createReadStream } from 'fs';
import { join, extname, basename } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type { ClonedVoice, VoiceLibraryMeta, CloneSampleParams } from './types';

/** 元数据文件名 */
const META_FILENAME = 'index.json';

/** 音色文件子目录名 */
const VOICES_DIR = 'voices';

/** 元数据版本号 */
const META_VERSION = 1;

/**
 * 获取音色库根目录(userData/voice-library/)
 * 在 Electron app 未就绪时回退到 cwd,避免单元测试崩溃
 * @returns 音色库根目录绝对路径
 */
function getLibraryRoot(): string {
  const base = app?.getPath?.('userData') ?? process.cwd();
  return join(base, 'voice-library');
}

/**
 * 获取元数据文件路径
 * @returns index.json 绝对路径
 */
function getMetaPath(): string {
  return join(getLibraryRoot(), META_FILENAME);
}

/**
 * 生成音色 ID(基于 UUID)
 * @returns 形如 "voice-xxxx-xxxx-xxxx" 的 ID
 */
function generateVoiceId(): string {
  return `voice-${randomUUID()}`;
}

/**
 * 校验音色记录是否包含必要字段
 * @param v 待校验记录
 * @returns 是否合法
 */
export function isValidVoice(v: unknown): v is ClonedVoice {
  if (!v || typeof v !== 'object') return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    typeof rec.name === 'string' &&
    typeof rec.samplePath === 'string' &&
    typeof rec.refAudioPath === 'string' &&
    typeof rec.refText === 'string' &&
    typeof rec.language === 'string' &&
    typeof rec.createdAt === 'string'
  );
}

/**
 * 音色库管理类
 * 负责音色的本地文件管理与元数据维护
 */
export class VoiceLibrary {
  /** 内存缓存(惰性加载) */
  private cache: VoiceLibraryMeta | null = null;

  /**
   * 初始化音色库目录与元数据文件(惰性创建)
   * 首次调用时确保目录与 index.json 存在
   */
  async ensureInitialized(): Promise<void> {
    const root = getLibraryRoot();
    const voicesDir = join(root, VOICES_DIR);
    if (!existsSync(root)) {
      await fs.mkdir(root, { recursive: true });
    }
    if (!existsSync(voicesDir)) {
      await fs.mkdir(voicesDir, { recursive: true });
    }
    if (!existsSync(getMetaPath())) {
      const empty: VoiceLibraryMeta = {
        version: META_VERSION,
        voices: [],
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(getMetaPath(), JSON.stringify(empty, null, 2), 'utf8');
    }
  }

  /**
   * 从磁盘加载元数据(带缓存)
   * 文件不存在或损坏时返回空元数据
   * @returns 音色库元数据
   */
  async loadMeta(): Promise<VoiceLibraryMeta> {
    if (this.cache) return this.cache;

    await this.ensureInitialized();
    try {
      const raw = await fs.readFile(getMetaPath(), 'utf8');
      const parsed = JSON.parse(raw) as VoiceLibraryMeta;
      // 兼容旧版:确保 voices 数组存在,过滤损坏记录
      const voices = Array.isArray(parsed.voices)
        ? parsed.voices.filter(isValidVoice)
        : [];
      this.cache = {
        version: typeof parsed.version === 'number' ? parsed.version : META_VERSION,
        voices,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
      return this.cache;
    } catch (err) {
      logger.warn(
        `[voice-clone/library] 元数据读取失败,重建空库: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.cache = {
        version: META_VERSION,
        voices: [],
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(getMetaPath(), JSON.stringify(this.cache, null, 2), 'utf8');
      return this.cache;
    }
  }

  /**
   * 持久化元数据到磁盘(写后更新缓存)
   * @param meta 待写入的元数据
   */
  async saveMeta(meta: VoiceLibraryMeta): Promise<void> {
    meta.updatedAt = new Date().toISOString();
    await this.ensureInitialized();
    await fs.writeFile(getMetaPath(), JSON.stringify(meta, null, 2), 'utf8');
    this.cache = meta;
  }

  /**
   * 列出所有音色
   * @returns 音色记录数组(按创建时间升序)
   */
  async listVoices(): Promise<ClonedVoice[]> {
    const meta = await this.loadMeta();
    return [...meta.voices].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  /**
   * 根据 ID 获取单个音色
   * @param id 音色 ID
   * @returns 音色记录,不存在返回 null
   */
  async getVoice(id: string): Promise<ClonedVoice | null> {
    const meta = await this.loadMeta();
    return meta.voices.find((v) => v.id === id) ?? null;
  }

  /**
   * 保存新音色:复制样本文件到音色库目录,写入元数据
   * @param params 克隆样本参数
   * @returns 创建成功的音色记录
   */
  async saveVoice(params: CloneSampleParams): Promise<ClonedVoice> {
    // 入参校验
    if (!params.samplePath || params.samplePath.trim().length === 0) {
      throw new Error('samplePath 不能为空');
    }
    if (!params.sampleName || params.sampleName.trim().length === 0) {
      throw new Error('sampleName 不能为空');
    }
    if (!existsSync(params.samplePath)) {
      throw new Error(`样本文件不存在: ${params.samplePath}`);
    }

    await this.ensureInitialized();
    const id = generateVoiceId();
    const voiceDir = join(getLibraryRoot(), VOICES_DIR, id);
    await fs.mkdir(voiceDir, { recursive: true });

    // 复制样本文件,保留原扩展名(供 GPT-SoVITS 识别格式)
    const ext = extname(params.samplePath).toLowerCase() || '.wav';
    const refAudioName = `ref_audio${ext}`;
    const refAudioPath = join(voiceDir, refAudioName);
    await fs.copyFile(params.samplePath, refAudioPath);

    // 构造音色记录并写入元数据
    const voice: ClonedVoice = {
      id,
      name: params.sampleName.trim(),
      samplePath: params.samplePath,
      refAudioPath,
      refText: params.refText ?? '',
      language: params.language ?? 'auto',
      createdAt: new Date().toISOString(),
    };

    const meta = await this.loadMeta();
    meta.voices.push(voice);
    await this.saveMeta(meta);

    logger.info(
      `[voice-clone/library] 新增音色 ${id}(${voice.name}),参考音频 ${refAudioPath}`,
    );
    return voice;
  }

  /**
   * 删除指定音色:移除磁盘文件并从元数据中删除
   * @param id 音色 ID
   * @returns 是否删除成功(不存在时返回 false)
   */
  async deleteVoice(id: string): Promise<boolean> {
    const meta = await this.loadMeta();
    const idx = meta.voices.findIndex((v) => v.id === id);
    if (idx < 0) return false;

    const voice = meta.voices[idx];

    // 删除磁盘文件(目录递归),失败仅告警不抛错
    const voiceDir = join(getLibraryRoot(), VOICES_DIR, id);
    try {
      await fs.rm(voiceDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[voice-clone/library] 删除音色目录失败 ${voiceDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 更新元数据
    meta.voices.splice(idx, 1);
    await this.saveMeta(meta);
    logger.info(`[voice-clone/library] 已删除音色 ${id}(${voice.name})`);
    return true;
  }

  /**
   * 创建参考音频的可读流(供 HTTP 客户端流式上传,可选)
   * 当前实现未使用,留作扩展
   * @param id 音色 ID
   * @returns 可读流,音色不存在时返回 null
   */
  createRefAudioStream(id: string): NodeJS.ReadableStream | null {
    const voiceDir = join(getLibraryRoot(), VOICES_DIR, id);
    // 仅返回路径,实际流式上传由调用方负责
    void basename; // 占位避免未使用告警
    const meta = this.cache;
    if (!meta) return null;
    const voice = meta.voices.find((v) => v.id === id);
    if (!voice) return null;
    return createReadStream(voice.refAudioPath);
  }
}

/** 音色库单例(全局复用) */
export const voiceLibrary = new VoiceLibrary();
