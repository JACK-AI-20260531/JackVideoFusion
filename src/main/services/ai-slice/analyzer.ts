/**
 * 精彩度分析引擎
 *
 * 职责:对镜头检测结果的每个镜头进行精彩度评分,并按阈值过滤
 *
 * 评分策略(简化,不依赖 LLM):
 *   1. 场景变化分数(shot.score,检测时已有):反映镜头切换的显著性
 *   2. 镜头时长评分:8-30 秒为黄金区间(满分),过短/过长降分
 *   3. CLIP 语义评分:镜头中间帧与"精彩/有趣/动作"等文本向量的相似度
 *   综合评分 = 0.4 * 场景分 + 0.3 * 时长分 + 0.3 * CLIP 分,归一化到 0-1
 *
 * 过滤:duration 在 [minClipDuration, maxClipDuration] 且 score > excitementThreshold
 *
 * 容错:CLIP 服务不可用或推理失败时,CLIP 分降级为 0,不影响整体流程
 */
import { getClipService } from '../clip';
import type { Embedding } from '../clip';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import type { TaskQueue } from '../task-queue';
import { logger } from '../../utils/logger';
import type { Shot } from '../shot-detect';
import type { AnalyzedShot, AnalyzeOptions } from './types';

/** 精彩相关文本(用于 CLIP 语义比对) */
const EXCITEMENT_TEXTS = ['精彩画面', '有趣场景', '动作高潮', '震撼视觉'];

/** 黄金时长区间下限(秒) */
const GOLDEN_MIN_SEC = 8;
/** 黄金时长区间上限(秒) */
const GOLDEN_MAX_SEC = 30;

/** 分析阶段起始进度(%) */
const PROGRESS_START = 15;
/** 分析阶段进度跨度(%) */
const PROGRESS_RANGE = 20;

/**
 * 把数值限制在 [min, max] 区间
 * @param v 输入值
 * @param min 最小值(含)
 * @param max 最大值(含)
 * @returns 限定后的值
 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 计算镜头时长评分
 * 8-30 秒为黄金区间(评分 1),<8 秒线性递减,>30 秒线性递减
 * @param duration 镜头时长(秒)
 * @returns 时长评分(0-1)
 */
function scoreDuration(duration: number): number {
  if (duration >= GOLDEN_MIN_SEC && duration <= GOLDEN_MAX_SEC) {
    return 1;
  }
  if (duration < GOLDEN_MIN_SEC) {
    return clamp(duration / GOLDEN_MIN_SEC, 0, 1);
  }
  // 超过 30 秒:每超 60 秒降 1,最低 0
  const overflow = duration - GOLDEN_MAX_SEC;
  return clamp(1 - overflow / 60, 0, 1);
}

/**
 * 计算镜头中间时间点
 * @param shot 镜头信息
 * @returns 中间时间点(秒)
 */
function midTimeOf(shot: Shot): number {
  return (shot.startTime + shot.endTime) / 2;
}

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('AI 切片任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 预计算精彩文本的嵌入向量
 * @returns 文本嵌入向量数组;CLIP 不可用时返回空数组
 */
async function preloadTextEmbeddings(): Promise<Embedding[]> {
  try {
    const clip = await getClipService();
    const embeddings = await Promise.all(
      EXCITEMENT_TEXTS.map((t) => clip.embedText(t)),
    );
    logger.info(
      `[ai-slice/analyzer] CLIP 文本向量预计算完成: ${embeddings.length} 个 (isRealModel=${clip.isRealModel})`,
    );
    return embeddings;
  } catch (err) {
    logger.warn(
      `[ai-slice/analyzer] CLIP 服务不可用,跳过语义评分: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * 计算单镜头的 CLIP 语义评分
 * 取镜头中间帧与所有精彩文本向量的最大余弦相似度,映射到 0-1
 * @param videoPath 视频路径
 * @param shot 镜头信息
 * @param textEmbeddings 预计算的文本向量
 * @returns CLIP 语义评分(0-1);不可用时返回 0
 */
async function scoreClipSemantic(
  videoPath: string,
  shot: Shot,
  textEmbeddings: Embedding[],
): Promise<number> {
  if (textEmbeddings.length === 0) return 0;
  try {
    const clip = await getClipService();
    const frameVec = await clip.embedVideoFrame(videoPath, midTimeOf(shot));
    let maxSim = -1;
    for (const textVec of textEmbeddings) {
      const sim = clip.cosineSimilarity(frameVec, textVec);
      if (sim > maxSim) maxSim = sim;
    }
    // 余弦相似度通常在 0-0.4 区间,*2.5 映射到 0-1
    return clamp(maxSim * 2.5, 0, 1);
  } catch (err) {
    logger.warn(
      `[ai-slice/analyzer] 镜头 ${shot.index} CLIP 评分失败,降级为 0: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * 分析镜头精彩度
 *
 * 流程:
 *   1. 预计算精彩文本的 CLIP 向量
 *   2. 对每个镜头:抽中间帧 → 计算 CLIP 语义分 → 综合场景分/时长分
 *   3. 过滤:duration 在 [minClipDuration, maxClipDuration] 且 score > excitementThreshold
 *   4. 返回达标镜头的评分结果(按评分降序)
 *
 * @param videoPath 视频文件路径
 * @param shots 镜头列表(由 shotDetectService.detect 产出)
 * @param options 分析参数(时长/阈值)
 * @param taskQueue 任务队列(用于进度推送)
 * @param taskId 任务 ID
 * @param token 取消令牌
 * @returns 达标镜头评分列表(按评分降序)
 */
export async function analyzeShots(
  videoPath: string,
  shots: Shot[],
  options: AnalyzeOptions,
  taskQueue: TaskQueue,
  taskId: string,
  token: CancelToken,
): Promise<AnalyzedShot[]> {
  logger.info(
    `[ai-slice/analyzer] 任务 ${taskId} 开始分析: ${shots.length} 个镜头, 阈值=${options.excitementThreshold}`,
  );

  // 1. 预计算文本向量
  const textEmbeddings = await preloadTextEmbeddings();

  // 2. 逐镜头评分
  const all: AnalyzedShot[] = [];
  for (let i = 0; i < shots.length; i++) {
    assertNotCancelled(token, taskId);
    const shot = shots[i];
    const sceneScore = clamp(shot.score ?? 0, 0, 1);
    const durationScore = scoreDuration(shot.duration);
    const clipScore = await scoreClipSemantic(videoPath, shot, textEmbeddings);
    // 综合:0.4 * 场景 + 0.3 * 时长 + 0.3 * CLIP
    const total = clamp(
      0.4 * sceneScore + 0.3 * durationScore + 0.3 * clipScore,
      0,
      1,
    );
    all.push({ shot, score: total });

    // 进度:15-35%,共 20%
    const progress = PROGRESS_START + PROGRESS_RANGE * ((i + 1) / shots.length);
    taskQueue.saveCheckpoint(taskId, 'ai-slice-analyze', progress, {
      analyzed: i + 1,
      total: shots.length,
    });
  }

  // 3. 过滤达标镜头
  const filtered = all.filter((a) => {
    const dur = a.shot.duration;
    return (
      dur >= options.minClipDuration &&
      dur <= options.maxClipDuration &&
      a.score > options.excitementThreshold
    );
  });

  // 4. 按评分降序
  filtered.sort((a, b) => b.score - a.score);

  logger.info(
    `[ai-slice/analyzer] 任务 ${taskId} 分析完成: ${all.length} → ${filtered.length} 个达标镜头`,
  );
  return filtered;
}
