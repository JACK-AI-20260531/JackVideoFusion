/**
 * 素材查重存储(PRD-v1.7 数据飞轮与全景矩阵 FR-5)
 *
 * 职责:
 *   - 素材感知哈希(dHash 64 位)的持久化,userData/material-repo/dedup.json
 *   - 文件夹查重编排:抽帧 → 计算哈希 → 存储查重时按汉明距离 ≤ 8 分组
 *
 * 设计约定:
 *   - 依赖注入 load/persist 与哈希计算函数,单测绕开 electron/ffmpeg
 *   - 查重按需触发(material:dedupScan),不做全库后台扫描
 */
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger';
import { isDuplicate, DUPLICATE_HASH_DISTANCE, dHash64 } from './imagehash';
import { ffmpegService } from '../ffmpeg';

/** 路径 → dHash(16 字符 hex) */
export type DedupRecord = Record<string, string>;

/** DedupStore 依赖注入 */
export interface DedupStoreDeps {
  load?: () => DedupRecord;
  persist?: (record: DedupRecord) => void;
}

/** 默认持久化文件路径(userData/material-repo/dedup.json) */
function dedupFile(): string {
  const dir = join(app.getPath('userData'), 'material-repo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'dedup.json');
}

/** 默认加载实现 */
function defaultLoad(): DedupRecord {
  try {
    const fp = dedupFile();
    if (!existsSync(fp)) return {};
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as DedupRecord) : {};
  } catch (err) {
    logger.error(`[dedup] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** 默认持久化实现 */
function defaultPersist(record: DedupRecord): void {
  try {
    const fp = dedupFile();
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    logger.error(`[dedup] 持久化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 查重存储:路径 → 哈希
 */
export class DedupStore {
  private record: DedupRecord = {};
  private readonly loadFn: () => DedupRecord;
  private readonly persistFn: (record: DedupRecord) => void;
  private loaded = false;

  constructor(deps: DedupStoreDeps = {}) {
    this.loadFn = deps.load ?? defaultLoad;
    this.persistFn = deps.persist ?? defaultPersist;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = this.loadFn();
    this.record = stored && typeof stored === 'object' ? stored : {};
    this.loaded = true;
  }

  private flush(): void {
    this.persistFn(this.record);
  }

  /** 写入/更新哈希 */
  set(path: string, hash: string): void {
    this.ensureLoaded();
    this.record[path] = hash;
    this.flush();
  }

  /** 查询哈希 */
  get(path: string): string | null {
    this.ensureLoaded();
    return this.record[path] ?? null;
  }

  /** 移除(素材删除时) */
  remove(path: string): void {
    this.ensureLoaded();
    if (this.record[path]) {
      delete this.record[path];
      this.flush();
    }
  }

  /** 全量记录(只读副本) */
  list(): DedupRecord {
    this.ensureLoaded();
    return { ...this.record };
  }
}

/** 查重结果分组 */
export interface DuplicateGroup {
  /** 基准路径 */
  path: string;
  /** 基准哈希 */
  hash: string;
  /** 与基准重复的其他路径 */
  duplicates: string[];
}

/**
 * 从哈希记录中提取重复分组(纯函数,O(n²) 两两比较,素材库规模可接受)
 * @param record 路径 → 哈希
 * @param maxDistance 最大汉明距离(默认 8)
 * @returns 重复分组(仅含有重复项的条目)
 */
export function groupDuplicates(
  record: DedupRecord,
  maxDistance = DUPLICATE_HASH_DISTANCE,
): DuplicateGroup[] {
  const paths = Object.keys(record);
  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < paths.length; i++) {
    const duplicates: string[] = [];
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      if (isDuplicate(record[paths[i]], record[paths[j]], maxDistance)) {
        duplicates.push(paths[j]);
      }
    }
    if (duplicates.length > 0) {
      groups.push({ path: paths[i], hash: record[paths[i]], duplicates });
    }
  }
  return groups;
}

/**
 * 对一批素材计算感知哈希(编排:抽帧 → dHash → 存储)
 * 单个文件失败跳过不阻断(如损坏文件),全部尽力而为
 * @param paths 素材路径列表
 * @param opts.computeHash 哈希计算函数(默认 ffmpeg 抽帧 + dHash64,可注入 mock)
 * @param opts.store 查重存储(默认全局单例)
 * @returns { computed, failed } 成功/失败条数
 */
export async function computeHashes(
  paths: string[],
  opts: {
    computeHash?: (path: string) => Promise<string>;
    store?: DedupStore;
  } = {},
): Promise<{ computed: number; failed: number }> {
  const store = opts.store ?? dedupStore;
  const compute = opts.computeHash ?? defaultComputeHash;
  let computed = 0;
  let failed = 0;
  for (const p of paths) {
    try {
      const hash = await compute(p);
      if (!hash) {
        failed++;
        continue;
      }
      store.set(p, hash);
      computed++;
    } catch (err) {
      failed++;
      logger.warn(
        `[dedup] 计算哈希失败 ${p}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { computed, failed };
}

/** 默认哈希计算:ffmpeg 抽 9x8 灰度帧 → dHash64 */
async function defaultComputeHash(path: string): Promise<string> {
  const pixels = await ffmpegService.extractGray9x8(path);
  return dHash64(pixels);
}

/** 查重存储单例 */
export const dedupStore = new DedupStore();
