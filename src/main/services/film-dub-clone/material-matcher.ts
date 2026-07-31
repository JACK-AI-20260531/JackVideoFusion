/**
 * 素材匹配引擎
 *
 * 职责:把参考视频的每个镜头与自有素材帧视觉对齐,生成 ShotMatch[] 供 cloner 复刻节奏
 *
 * 执行流程:
 *   1. 扫描 folderId 的视频素材(单文件夹隔离)
 *   2. 对每个自有素材视频:probe 时长 → 按固定间隔抽帧 → CLIP embedVideoFrame(带缓存)
 *   3. 对参考视频每个镜头:取中间帧 → CLIP embedVideoFrame
 *   4. 用 clipService.cosineSimilarity 为每个参考镜头选最相似的自有素材帧
 *      (优先未用过的素材帧,避免同一帧被多次复用导致画面重复)
 *   5. 每步 saveCheckpoint + 检查 token.cancelled
 *
 * 文件夹隔离:全程仅对入参 folderId 调用 materialRepo.scanFolder / listMaterials,
 *            绝不读取其他 folderId 的数据。
 *
 * 性能优化:
 *   - 抽帧向量缓存:`videoPath|timeSec` → Embedding,避免重复计算
 *   - 候选帧复用:所有参考镜头共享同一候选帧池
 */
import type { Embedding } from '../clip';
import type { MaterialMeta } from '@shared/types';
import { getClipService } from '../clip';
import { materialRepo } from '../material-repo';
import { ffmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { TaskQueue } from '../task-queue';
import { logger } from '../../utils/logger';
import type { RhythmPattern, ShotMatch } from './types';
import type { Shot } from '../shot-detect';

/** 自有素材抽帧间隔(秒):每 5 秒抽一帧用于视觉匹配 */
const FRAME_INTERVAL_SEC = 5;

/** 抽帧时间点偏移(秒):避免从 0s 抽帧(黑屏概率高) */
const FRAME_START_OFFSET_SEC = 0.5;

/** 候选项:携带自身向量与时间点的素材帧 */
interface FrameCandidate {
  /** 素材视频文件路径 */
  videoPath: string;
  /** 抽帧时间点(秒) */
  timeSec: number;
  /** 该帧的嵌入向量 */
  embedding: Embedding;
}

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 构造抽帧缓存键
 * @param videoPath 视频路径
 * @param timeSec 抽帧时间点(秒)
 * @returns 缓存键 `path|time`
 */
function frameCacheKey(videoPath: string, timeSec: number): string {
  return `${videoPath}|${timeSec}`;
}

/**
 * 获取视频所有抽帧时间点(从 FRAME_START_OFFSET 开始,每 FRAME_INTERVAL_SEC 一帧)
 * @param durationSec 视频时长(秒)
 * @returns 抽帧时间点数组
 */
function listSampleTimes(durationSec: number): number[] {
  if (!durationSec || durationSec <= 0) return [];
  const times: number[] = [];
  for (let t = FRAME_START_OFFSET_SEC; t < durationSec; t += FRAME_INTERVAL_SEC) {
    times.push(Number(t.toFixed(2)));
  }
  // 至少返回一个时间点(若视频短于一帧间隔,取中点)
  if (times.length === 0 && durationSec > 0) {
    times.push(Number((durationSec / 2).toFixed(2)));
  }
  return times;
}

/**
 * 计算参考镜头的中间帧时间点
 * @param shot 镜头节点
 * @returns 中间帧时间点(秒)
 */
function shotMidTime(shot: Shot): number {
  const mid = (shot.startTime + shot.endTime) / 2;
  // 钳制到 [startTime, endTime] 内,避免越界
  return Number(Math.max(shot.startTime, Math.min(shot.endTime, mid)).toFixed(2));
}

/**
 * 执行素材匹配:参考镜头 → 自有素材帧
 *
 * 算法:
 *   1. 扫描 folderId 视频素材(隔离硬约束)
 *   2. 对每个素材按固定间隔抽帧做画面嵌入(带缓存),构成候选帧池
 *   3. 对每个参考镜头取中间帧嵌入,与候选帧池做余弦相似度比较
 *   4. 选最高分候选(优先未用过的素材路径,避免画面重复)
 *
 * @param rhythm 参考视频节奏特征(含镜头序列与参考视频路径)
 * @param folderId 自有素材文件夹 ID(单文件夹隔离)
 * @param script 解说文案(预留:未来可用 LLM 做段落语义加权;当前仅日志)
 * @param taskQueue 任务队列单例(用于 checkpoint)
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns 镜头匹配列表(按参考镜头顺序)
 */
export async function matchMaterials(
  rhythm: RhythmPattern,
  folderId: string,
  script: string,
  taskQueue: TaskQueue,
  taskId: string,
  token: CancelToken,
): Promise<ShotMatch[]> {
  logger.info(
    `[film-dub-clone/matcher] 任务 ${taskId} 开始素材匹配: folderId=${folderId}, ` +
      `参考镜头 ${rhythm.shots.length} 个, 文案 ${script.length} 字符`,
  );

  // ===== 1. 入参校验(文件夹隔离硬约束) =====
  if (!folderId) {
    throw new Error('[film-dub-clone/matcher] folderId 为空,违反文件夹隔离约束');
  }
  if (rhythm.shots.length === 0) {
    throw new Error('[film-dub-clone/matcher] 参考镜头序列为空,无法匹配');
  }

  // ===== 2. 扫描素材(单文件夹隔离) =====
  assertNotCancelled(token, taskId);
  await materialRepo.scanFolder(folderId);
  const allMaterials = materialRepo.listMaterials(folderId);
  const videoMaterials = allMaterials.filter((m: MaterialMeta) => m.kind === 'video');
  if (videoMaterials.length === 0) {
    throw new Error(`[film-dub-clone/matcher] 文件夹 ${folderId} 无视频素材`);
  }
  logger.info(
    `[film-dub-clone/matcher] 文件夹 ${folderId} 共 ${videoMaterials.length} 个视频素材`,
  );

  // ===== 3. 自有素材抽帧向量化(带缓存) =====
  assertNotCancelled(token, taskId);
  const clip = await getClipService();
  const frameVecCache = new Map<string, Embedding>();
  const candidates: FrameCandidate[] = [];

  // 预估总帧数用于进度计算
  let totalFrames = 0;
  for (const m of videoMaterials) {
    const dur = m.durationSec ?? 0;
    totalFrames += listSampleTimes(dur > 0 ? dur : FRAME_INTERVAL_SEC).length;
  }
  if (totalFrames === 0) totalFrames = videoMaterials.length; // 兜底

  let processedFrames = 0;
  for (let vi = 0; vi < videoMaterials.length; vi++) {
    assertNotCancelled(token, taskId);
    const mat = videoMaterials[vi];
    // 探测时长(扫描器不填 durationSec,这里 probe 一次以获得准确时长)
    let durationSec = mat.durationSec ?? 0;
    if (!durationSec || durationSec <= 0) {
      try {
        const meta = await ffmpegService.probe(mat.path);
        durationSec = meta.durationSec;
      } catch (err) {
        logger.warn(
          `[film-dub-clone/matcher] 探测素材时长失败,降级使用 ${FRAME_INTERVAL_SEC}s: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        durationSec = FRAME_INTERVAL_SEC;
      }
    }
    const times = listSampleTimes(durationSec);
    for (const t of times) {
      assertNotCancelled(token, taskId);
      const key = frameCacheKey(mat.path, t);
      let vec = frameVecCache.get(key);
      if (!vec) {
        vec = await clip.embedVideoFrame(mat.path, t);
        frameVecCache.set(key, vec);
      }
      candidates.push({ videoPath: mat.path, timeSec: t, embedding: vec });
      processedFrames++;
      // 素材抽帧阶段:10% → 40%
      const progress = 10 + 30 * (processedFrames / totalFrames);
      taskQueue.saveCheckpoint(taskId, 'film-dub-frame-embed', progress, {
        videoIndex: vi,
        frameIndex: processedFrames,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error('[film-dub-clone/matcher] 未能从素材中抽取出任何帧向量');
  }
  logger.info(
    `[film-dub-clone/matcher] 共生成 ${candidates.length} 个候选帧`,
  );

  // ===== 4. 参考镜头逐个匹配最佳素材帧 =====
  assertNotCancelled(token, taskId);
  const refVecCache = new Map<string, Embedding>();
  // 已使用的素材路径集合:优先不重复同一素材文件,提升画面多样性
  const usedMaterialPaths = new Set<string>();
  const matches: ShotMatch[] = [];

  for (let si = 0; si < rhythm.shots.length; si++) {
    assertNotCancelled(token, taskId);
    const shot = rhythm.shots[si];
    const midTime = shotMidTime(shot);
    const refKey = frameCacheKey(rhythm.referenceVideoPath, midTime);
    let refVec = refVecCache.get(refKey);
    if (!refVec) {
      refVec = await clip.embedVideoFrame(rhythm.referenceVideoPath, midTime);
      refVecCache.set(refKey, refVec);
    }

    // 在候选帧池中找最高分;优先未用过的素材路径,其次已用过的
    let bestFresh: FrameCandidate | null = null;
    let bestFreshScore = -Infinity;
    let bestUsed: FrameCandidate | null = null;
    let bestUsedScore = -Infinity;
    for (const cand of candidates) {
      const score = clip.cosineSimilarity(refVec, cand.embedding);
      if (usedMaterialPaths.has(cand.videoPath)) {
        if (score > bestUsedScore) {
          bestUsedScore = score;
          bestUsed = cand;
        }
      } else {
        if (score > bestFreshScore) {
          bestFreshScore = score;
          bestFresh = cand;
        }
      }
    }
    // 优先未用过的素材;若全部已用,降级用已用素材中最高分
    const finalCand = bestFresh ?? bestUsed;
    if (!finalCand) {
      throw new Error(`[film-dub-clone/matcher] 镜头 ${si} 无法找到匹配画面`);
    }
    usedMaterialPaths.add(finalCand.videoPath);

    matches.push({
      shot,
      materialPath: finalCand.videoPath,
      timeSec: finalCand.timeSec,
    });

    // 镜头匹配阶段:40% → 55%
    const progress = 40 + 15 * ((si + 1) / rhythm.shots.length);
    taskQueue.saveCheckpoint(taskId, 'film-dub-match', progress, {
      shotIndex: si,
      matchesSoFar: matches.length,
    });
  }

  taskQueue.saveCheckpoint(taskId, 'film-dub-match-done', 55, {
    matchCount: matches.length,
  });
  logger.info(
    `[film-dub-clone/matcher] 任务 ${taskId} 匹配完成: ${matches.length} 段`,
  );
  return matches;
}
