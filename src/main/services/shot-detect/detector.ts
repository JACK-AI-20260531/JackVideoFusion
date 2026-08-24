/**
 * 镜头检测核心逻辑
 *
 * 基于 ffprobe 的 scene 滤镜检测视频镜头切换点,
 * 把切换点序列转换为镜头列表,并合并过短镜头。
 * 任何失败(滤镜不可用/解析失败/ffprobe 缺失)统一降级为均匀分段。
 *
 * 设计约定:
 *   - 复用 ffmpegService 已配置的 ffprobe 路径,不重复探测二进制
 *   - 使用 execFile(非 exec)避免 shell 注入风险
 *   - ffprobe JSON 输出用类型断言/窄化处理,不使用 any
 */
import { execFile } from 'child_process';
import { ffmpegService } from '../ffmpeg';
import { logger } from '../../utils/logger';
import type { DetectOptions, DetectResult } from './types';
import {
  clamp,
  parseTimeBase,
  extractSceneScore,
  buildShotsFromCuts,
  mergeShortShots,
  fallbackUniformSplit,
} from './shot-utils';

/** 默认场景变化阈值 */
const DEFAULT_THRESHOLD = 0.4;
/** 默认最小镜头时长(秒) */
const DEFAULT_MIN_DURATION = 1.0;
/** execFile 输出最大缓冲区(64MB,足以容纳大型视频的 frame JSON) */
const MAX_BUFFER = 64 * 1024 * 1024;
/** 首帧判定阈值(秒):早于此时间视为视频起点而非切换点 */
const FIRST_FRAME_THRESHOLD = 0.05;

/** ffprobe -show_frames JSON 输出的最小结构 */
interface FfprobeFramesOutput {
  /** 帧数组 */
  frames: FfprobeFrame[];
}

/** ffprobe 单帧结构(仅取检测需要的字段) */
interface FfprobeFrame {
  /** 帧的呈现时间(秒,字符串形式) */
  pts_time?: string;
  /** 帧 pts(整数,时间基单位,作为降级回退) */
  pts?: number;
  /** 时间基,如 "1/15360" */
  time_base?: string;
  /** 副数据列表(可能含 Scene Detection 分数) */
  side_data_list?: FfprobeSideData[];
}

/** ffprobe side_data 结构 */
interface FfprobeSideData {
  /** 副数据类型,如 "Scene Detection" */
  side_data_type?: string;
  /** 场景变化分数(0-1) */
  score?: number;
}

/**
 * 检测视频镜头边界
 * 流程:probe 拿时长 → ffprobe scene 滤镜拿切换点 → 转换为镜头列表 → 合并短镜头
 * 失败时降级为均匀分段,并在日志中记录降级原因。
 * @param videoPath 视频文件路径
 * @param opts 检测参数(可选)
 * @returns 检测结果
 */
export async function detectShots(
  videoPath: string,
  opts?: DetectOptions,
): Promise<DetectResult> {
  const threshold = clamp(opts?.threshold ?? DEFAULT_THRESHOLD, 0, 1);
  const minDuration = Math.max(0.1, opts?.minDuration ?? DEFAULT_MIN_DURATION);

  // 1. 获取视频总时长(同时触发 ffmpeg/ffprobe 二进制检测)
  const meta = await ffmpegService.probe(videoPath);
  const totalDuration = meta.durationSec > 0 ? meta.durationSec : 0;
  if (totalDuration <= 0) {
    logger.warn('[ShotDetect] 视频时长为 0,返回空镜头结果');
    return { shots: [], totalDuration: 0, shotCount: 0 };
  }

  // 2. 尝试用 ffprobe scene 滤镜检测场景切换点
  let cutPoints: number[] = [];
  let scores: number[] = [];
  try {
    const detected = await runSceneDetect(videoPath, threshold);
    cutPoints = detected.points;
    scores = detected.sceneScores;
    logger.info(`[ShotDetect] ffprobe 检测到 ${cutPoints.length} 个切换点`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`[ShotDetect] ffprobe 场景检测失败,降级为均匀分段: ${reason}`);
    return fallbackUniformSplit(totalDuration, minDuration);
  }

  // 3. 把切换点转换为镜头列表
  let shots = buildShotsFromCuts(cutPoints, scores, totalDuration);

  // 4. 合并短于 minDuration 的镜头到上一个
  shots = mergeShortShots(shots, minDuration);

  // 5. 重建索引(合并后索引可能不连续)
  shots = shots.map((s, i) => ({ ...s, index: i }));

  logger.info(`[ShotDetect] 共生成 ${shots.length} 个镜头`);

  return {
    shots,
    totalDuration,
    shotCount: shots.length,
  };
}

/**
 * 调用 ffprobe 执行场景检测
 * 使用 -vf select='gt(scene,THRESHOLD)' 过滤出场景变化分数超过阈值的帧,
 * 解析 frames 数组的 pts_time 作为切换点时间(秒)。
 * @param videoPath 视频路径
 * @param threshold 场景变化阈值
 * @returns 切换点时间数组与对应的场景分数数组
 */
async function runSceneDetect(
  videoPath: string,
  threshold: number,
): Promise<{ points: number[]; sceneScores: number[] }> {
  // 通过 ffmpegService 拿到 ffprobe 路径(复用二进制检测,不重复探测)
  let ffprobePath: string | undefined;
  try {
    const bins = await ffmpegService.detectBinaries();
    ffprobePath = bins.ffprobePath;
  } catch (err) {
    throw new Error(
      `获取 ffprobe 路径失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!ffprobePath) {
    throw new Error('ffprobe 二进制不可用');
  }

  // ffprobe 参数:过滤出场景变化分数 > threshold 的帧
  // filter graph 中单引号包裹的字面值不会被解析为 filter 链分隔符
  const filterExpr = `select='gt(scene,${threshold})'`;
  const args: string[] = [
    '-v', 'quiet',
    '-show_frames',
    '-select_streams', 'v:0',
    '-of', 'json',
    '-vf', filterExpr,
    videoPath,
  ];

  const stdout = await runExecFile(ffprobePath, args);
  const parsed = parseFfprobeJson(stdout);
  return extractCutPoints(parsed);
}

/**
 * 用 execFile 执行命令并返回 stdout
 * 使用 execFile(非 exec)避免 shell 注入风险
 * @param file 可执行文件路径
 * @param args 参数数组
 * @returns stdout 内容
 */
function runExecFile(file: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER }, (err, stdout, _stderr) => {
      if (err) {
        reject(new Error(`ffprobe 执行失败: ${err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 解析 ffprobe JSON 输出
 * 用类型窄化确保不使用 any
 * @param stdout ffprobe 标准输出
 * @returns 解析后的 FfprobeFramesOutput 结构
 */
export function parseFfprobeJson(stdout: string): FfprobeFramesOutput {
  if (!stdout || stdout.trim().length === 0) {
    throw new Error('ffprobe 输出为空');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('ffprobe 输出不是对象');
  }
  const obj = raw as { frames?: unknown };
  if (!Array.isArray(obj.frames)) {
    throw new Error('ffprobe 输出缺少 frames 数组');
  }
  return { frames: obj.frames as FfprobeFrame[] };
}

/**
 * 从 ffprobe frames 中提取场景切换点时间
 * 优先用 pts_time(秒),否则用 pts * time_base 换算
 * 跳过接近 0 的首帧(它是镜头起点而非切换点)
 * @param output ffprobe 解析后的结构
 * @returns 切换点时间数组与场景分数数组
 */
export function extractCutPoints(output: FfprobeFramesOutput): {
  points: number[];
  sceneScores: number[];
} {
  const points: number[] = [];
  const sceneScores: number[] = [];
  for (const frame of output.frames) {
    let time: number | undefined;
    if (typeof frame.pts_time === 'string') {
      const t = parseFloat(frame.pts_time);
      if (!isNaN(t)) time = t;
    }
    if (time === undefined && typeof frame.pts === 'number') {
      const tb = parseTimeBase(frame.time_base);
      if (tb > 0) time = frame.pts * tb;
    }
    if (time === undefined) continue;
    // 跳过接近 0 的首帧(它是视频起点,不是切换点)
    if (time < FIRST_FRAME_THRESHOLD && points.length === 0) continue;
    points.push(time);
    sceneScores.push(extractSceneScore(frame.side_data_list));
  }
  return { points, sceneScores };
}

/* 镜头构建/合并/降级逻辑已提纯至 shot-utils.ts */
