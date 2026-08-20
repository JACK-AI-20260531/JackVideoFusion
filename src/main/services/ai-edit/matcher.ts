/**
 * 语义匹配引擎
 *
 * 职责:把文案段落与素材视频帧语义对齐,生成 SceneMatch[] 供 composer 合成成片
 *
 * 执行流程:
 *   1. 调用 llmService.extractKeywords 从文案抽取关键词
 *   2. 对每个关键词调用 clipService.embedText 得到文本向量
 *   3. 扫描 folderId 的视频素材,对每个视频按固定间隔(默认 5s)抽帧,
 *      用 clipService.embedVideoFrame 得到画面向量(同视频同时间点缓存)
 *   4. 用 clipService.cosineSimilarity 计算关键词向量与各画面向量的相似度
 *   5. 按文案段落(按句号/换行分段)顺序,为每段匹配最佳画面
 *   6. 每步 saveCheckpoint + 检查 token.cancelled
 *
 * 性能优化:
 *   - 抽帧向量缓存:`videoPath|timeSec` → Embedding,避免重复计算
 *   - 关键词向量缓存:keyword → Embedding
 *   - 单文件夹隔离:仅扫描入参 folderId 的素材
 */
import type { Embedding } from '../clip';
import type { MaterialMeta } from '@shared/types';
import { llmService } from '../llm';
import { getClipService } from '../clip';
import { materialRepo } from '../material-repo';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import { taskQueue } from '../task-queue';
import { logger } from '../../utils/logger';
import type { SceneMatch } from './types';

/** 抽帧间隔(秒):每 5 秒抽一帧用于语义匹配 */
const FRAME_INTERVAL_SEC = 5;

/** 段落默认时长(秒):未启用配音时每个段落切出的片段时长 */
const DEFAULT_SEGMENT_SEC = 3;

/** 抽帧时间点偏移(秒):避免从 0s 抽帧(黑屏概率高) */
const FRAME_START_OFFSET_SEC = 0.5;

/** 候选关键词最大数量(防止 LLM 返回过多关键词导致性能下降) */
const MAX_KEYWORDS = 20;

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
 * 把文案按句号/换行/问号/感叹号切分为段落
 * 空段落会被过滤;若切分后只有一段,则返回单元素数组
 * @param script 原始文案
 * @returns 段落数组(已 trim,过滤空串)
 */
export function splitParagraphs(script: string): string[] {
  if (!script) return [];
  // 按中文/英文句号、问号、感叹号、换行切分
  const parts = script
    .split(/[。\n\r!?！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

/**
 * 构造抽帧缓存键
 * @param videoPath 视频路径
 * @param timeSec 抽帧时间点(秒)
 * @returns 缓存键 `path|time`
 */
export function frameCacheKey(videoPath: string, timeSec: number): string {
  return `${videoPath}|${timeSec}`;
}

/**
 * 获取视频所有抽帧时间点(从 FRAME_START_OFFSET 开始,每 FRAME_INTERVAL_SEC 一帧)
 * @param durationSec 视频时长(秒)
 * @returns 抽帧时间点数组
 */
export function listSampleTimes(durationSec: number): number[] {
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
 * 候选项:携带自身向量与时间点的视频帧
 */
interface FrameCandidate {
  /** 视频文件路径 */
  videoPath: string;
  /** 抽帧时间点(秒) */
  timeSec: number;
  /** 该帧的嵌入向量 */
  embedding: Embedding;
}

/**
 * 执行语义匹配:文案段落 → 视频帧
 *
 * 算法:
 *   1. LLM 抽取关键词
 *   2. CLIP 对每个关键词做文本嵌入
 *   3. 扫描素材,对每个视频按固定间隔抽帧,做画面嵌入(带缓存)
 *   4. 对每个文案段落,选关键词向量与画面向量余弦相似度最高的帧
 *
 * @param script 文案
 * @param folderId 素材文件夹 ID(单文件夹隔离)
 * @param taskId 任务 ID(用于 checkpoint)
 * @param token 取消令牌
 * @returns 场景匹配列表(按段落顺序)与关键词列表
 */
export async function matchScenesToScript(
  script: string,
  folderId: string,
  taskId: string,
  token: CancelToken,
): Promise<{ matches: SceneMatch[]; keywords: string[] }> {
  logger.info(`[ai-edit/matcher] 任务 ${taskId} 开始语义匹配: folderId=${folderId}`);

  // ===== 1. 校验文案 =====
  if (!script || script.trim().length === 0) {
    throw new Error('[ai-edit/matcher] 文案为空,无法匹配');
  }
  if (!folderId) {
    throw new Error('[ai-edit/matcher] folderId 为空,违反文件夹隔离约束');
  }

  // ===== 2. 抽取关键词 =====
  assertNotCancelled(token, taskId);
  logger.info('[ai-edit/matcher] 调用 LLM 抽取关键词');
  const kwResult = await llmService.extractKeywords(script, MAX_KEYWORDS);
  const keywords = kwResult.keywords.filter((k) => k.trim().length > 0);
  if (keywords.length === 0) {
    throw new Error('[ai-edit/matcher] LLM 未抽取出任何关键词');
  }
  logger.info(`[ai-edit/matcher] 抽取到 ${keywords.length} 个关键词: ${keywords.join(', ')}`);
  taskQueue.saveCheckpoint(taskId, 'ai-edit-keywords', 10, { keywords });

  // ===== 3. 关键词向量化(带缓存) =====
  assertNotCancelled(token, taskId);
  const clip = await getClipService();
  const keywordVecCache = new Map<string, Embedding>();
  for (let i = 0; i < keywords.length; i++) {
    assertNotCancelled(token, taskId);
    const kw = keywords[i];
    if (!keywordVecCache.has(kw)) {
      const vec = await clip.embedText(kw);
      keywordVecCache.set(kw, vec);
    }
    // 关键词向量化阶段:10% → 25%
    const progress = 10 + 15 * ((i + 1) / keywords.length);
    taskQueue.saveCheckpoint(taskId, 'ai-edit-kw-embed', progress, {
      keywordIndex: i,
    });
  }

  // ===== 4. 扫描素材,抽帧向量化(带缓存) =====
  assertNotCancelled(token, taskId);
  await materialRepo.scanFolder(folderId);
  const allMaterials = materialRepo.listMaterials(folderId);
  const videoMaterials = allMaterials.filter((m: MaterialMeta) => m.kind === 'video');
  if (videoMaterials.length === 0) {
    throw new Error(`[ai-edit/matcher] 文件夹 ${folderId} 无视频素材`);
  }
  logger.info(`[ai-edit/matcher] 文件夹 ${folderId} 共 ${videoMaterials.length} 个视频素材`);

  const frameVecCache = new Map<string, Embedding>();
  const candidates: FrameCandidate[] = [];
  let totalFrames = 0;
  // 预估总帧数用于进度计算
  for (const m of videoMaterials) {
    if (m.durationSec && m.durationSec > 0) {
      totalFrames += listSampleTimes(m.durationSec).length;
    }
  }
  if (totalFrames === 0) totalFrames = videoMaterials.length; // 兜底

  let processedFrames = 0;
  for (let vi = 0; vi < videoMaterials.length; vi++) {
    assertNotCancelled(token, taskId);
    const mat = videoMaterials[vi];
    // 探测时长(若素材元数据缺 durationSec,从 FFmpeg 探测)
    let durationSec = mat.durationSec ?? 0;
    if (!durationSec || durationSec <= 0) {
      // 时长未知时,仅取一个时间点(0.5s)
      durationSec = FRAME_INTERVAL_SEC;
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
      // 抽帧向量化阶段:25% → 60%
      const progress = 25 + 35 * (processedFrames / totalFrames);
      taskQueue.saveCheckpoint(taskId, 'ai-edit-frame-embed', progress, {
        videoIndex: vi,
        frameIndex: processedFrames,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error('[ai-edit/matcher] 未能从素材中抽取出任何帧向量');
  }
  logger.info(`[ai-edit/matcher] 共生成 ${candidates.length} 个候选项`);

  // ===== 5. 按文案段落匹配最佳画面 =====
  assertNotCancelled(token, taskId);
  const paragraphs = splitParagraphs(script);
  if (paragraphs.length === 0) {
    throw new Error('[ai-edit/matcher] 文案无法分段');
  }
  logger.info(`[ai-edit/matcher] 文案分为 ${paragraphs.length} 段`);

  const matches: SceneMatch[] = [];
  const usedCandidateKeys = new Set<string>(); // 避免同一帧被多次使用(若候选充足)
  for (let pi = 0; pi < paragraphs.length; pi++) {
    assertNotCancelled(token, taskId);
    const paragraph = paragraphs[pi];

    // 为该段落选择关键词:取段落原文最匹配的关键词(简化:取轮询的关键词)
    // 改进:用段落文本向量化与所有关键词向量比较,选最相似的关键词
    const paraVec = await clip.embedText(paragraph);
    let bestKw = keywords[0];
    let bestKwScore = -Infinity;
    for (const kw of keywords) {
      const kwVec = keywordVecCache.get(kw);
      if (!kwVec) continue;
      const score = clip.cosineSimilarity(paraVec, kwVec);
      if (score > bestKwScore) {
        bestKwScore = score;
        bestKw = kw;
      }
    }
    const kwVec = keywordVecCache.get(bestKw) ?? keywordVecCache.get(keywords[0])!;

    // 用关键词向量与所有候选帧向量比较,取最高分(优先未用过的)
    let bestCandidate: FrameCandidate | null = null;
    let bestScore = -Infinity;
    let bestCandidateUsed: FrameCandidate | null = null;
    let bestScoreUsed = -Infinity;
    for (const cand of candidates) {
      const score = clip.cosineSimilarity(kwVec, cand.embedding);
      const ck = frameCacheKey(cand.videoPath, cand.timeSec);
      if (usedCandidateKeys.has(ck)) {
        if (score > bestScoreUsed) {
          bestScoreUsed = score;
          bestCandidateUsed = cand;
        }
      } else {
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = cand;
        }
      }
    }
    // 优先未用过的;若全部用过则降级用 used
    const finalCand = bestCandidate ?? bestCandidateUsed;
    const finalScore = bestCandidate ? bestScore : bestScoreUsed;
    if (!finalCand) {
      throw new Error(`[ai-edit/matcher] 段落 ${pi} 无法找到匹配画面`);
    }
    const finalKey = frameCacheKey(finalCand.videoPath, finalCand.timeSec);
    usedCandidateKeys.add(finalKey);

    matches.push({
      paragraph,
      keyword: bestKw,
      videoPath: finalCand.videoPath,
      timeSec: finalCand.timeSec,
      segmentSec: DEFAULT_SEGMENT_SEC,
      score: finalScore,
    });

    // 段落匹配阶段:60% → 90%
    const progress = 60 + 30 * ((pi + 1) / paragraphs.length);
    taskQueue.saveCheckpoint(taskId, 'ai-edit-match', progress, {
      paragraphIndex: pi,
      matchesSoFar: matches.length,
    });
  }

  taskQueue.saveCheckpoint(taskId, 'ai-edit-match-done', 90, {
    matchCount: matches.length,
  });
  logger.info(
    `[ai-edit/matcher] 任务 ${taskId} 匹配完成: ${matches.length} 段, 关键词 ${keywords.length} 个`,
  );
  return { matches, keywords };
}
