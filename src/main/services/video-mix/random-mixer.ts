/**
 * 随机素材混剪(模式一)实现
 *
 * 职责:从多个文件夹各抽取若干视频片段 → 可选切短分段 → 拼接 → 应用水印/字幕
 *
 * 执行流程:
 *   1. 校验:materialPaths 非空走清单模式(逐条直接参与);否则校验 folderIds 非空、perFolderCount>0
 *   2. 对每个 folderId:scanFolder → pickFromFolder(单文件夹抽取,隔离);清单模式跳过
 *   3. 对每个抽取的视频:若 segmentSec>0,用 ffmpegService.split 切短分段
 *   4. 用 ffmpegService.concat 拼接所有分段(filter 模式重编码以兼容异源)
 *   5. 应用 scale 滤镜统一比例(通过 transcode 阶段或 concat filter 后处理)
 *   6. 若 watermark.enabled:applyWatermark(用 toFfmpegPosition 转换位置)
 *   7. 若 subtitle.srtPath:burnSubtitle
 *   8. 每个原子步骤后保存 checkpoint 并推送进度
 *   9. 每步检查 token.cancelled,取消时抛 FFmpegError(CANCELLED)
 */
import { app } from 'electron';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { ffmpegService, type FFmpegService } from '../ffmpeg';
import { CancelToken, FFmpegError } from '../ffmpeg/types';
import { materialRepo, type MaterialRepo } from '../material-repo';
import { usageTracker, filterRecentUsage, type UsageTracker } from '../material-repo/usage-tracker';
import { brandStore, buildBrandFilter, hasBrandVisuals } from '../brand-kit';
import type { BrandKitConfig } from '../brand-kit';
import type { MaterialMeta } from '@shared/types';
import { taskQueue, type TaskQueue } from '../task-queue';
import {
  buildScaleFilter,
  toFfmpegPosition,
  resolveExportPath,
} from '../common';
import { logger } from '../../utils/logger';
import type { MixParams, MixResult } from './types';

/**
 * 随机混剪外部依赖(可注入以便单测)
 */
export interface RandomMixDeps {
  /** 任务工作目录根(userData),默认 app.getPath('userData') */
  userDataDir?: string;
  /** ffmpeg 服务(默认全局单例) */
  ffmpeg?: FFmpegService;
  /** 素材仓库(默认全局单例) */
  repo?: MaterialRepo;
  /** 任务队列(默认全局单例) */
  queue?: TaskQueue;
  /** 素材使用计数(默认全局单例;PRD-v1.7 FR-5 防撞车) */
  tracker?: UsageTracker;
}

/** 取注入的用户数据目录,否则回退到 electron app(测试环境回退 cwd) */
function getUserDataDir(deps: RandomMixDeps): string {
  if (deps.userDataDir) return deps.userDataDir;
  return app?.getPath?.('userData') ?? process.cwd();
}

/**
 * 创建任务专用工作目录:userData/video-mix-work/<taskId>/
 * 用于存放中间分段与中间拼接文件
 * @param taskId 任务 ID
 * @param deps 依赖(deps.userDataDir 指定工作目录根)
 * @returns 工作目录绝对路径
 */
async function ensureWorkDir(taskId: string, deps: RandomMixDeps): Promise<string> {
  const dir = join(getUserDataDir(deps), 'video-mix-work', taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 校验是否已取消,已取消则抛 FFmpegError(CANCELLED)
 * @param token 取消令牌
 * @param taskId 任务 ID(用于错误信息)
 */
function assertNotCancelled(token: CancelToken, taskId: string): void {
  if (token.cancelled) {
    throw new FFmpegError('任务已取消', { code: 'CANCELLED', taskId });
  }
}

/**
 * 把通用 WatermarkConfig 转换为 ffmpeg WatermarkOpts 并应用
 * @param input 输入视频
 * @param output 输出视频
 * @param watermark 水印配置
 * @param token 取消令牌
 * @returns 输出视频路径
 */
async function applyWatermarkIfNeeded(
  input: string,
  output: string,
  watermark: NonNullable<MixParams['watermark']>,
  token: CancelToken,
  ffmpeg: FFmpegService,
): Promise<string> {
  if (watermark.type === 'image') {
    return ffmpeg.applyWatermark(
      input,
      output,
      {
        type: 'image',
        image: watermark.content,
        position: toFfmpegPosition(watermark.position),
        marginX: watermark.marginX,
        marginY: watermark.marginY,
        scale: watermark.scale,
      },
      token,
    );
  }
  return ffmpeg.applyWatermark(
    input,
    output,
    {
      type: 'text',
      text: watermark.content,
      position: toFfmpegPosition(watermark.position),
      marginX: watermark.marginX,
      marginY: watermark.marginY,
      fontSize: watermark.fontSize,
      fontColor: watermark.fontColor,
      fontFile: watermark.fontFile,
    },
    token,
  );
}

/**
 * 烧录字幕(若配置)
 * @param input 输入视频
 * @param output 输出视频
 * @param subtitle 字幕配置
 * @param token 取消令牌
 * @returns 输出视频路径
 */
async function burnSubtitleIfNeeded(
  input: string,
  output: string,
  subtitle: NonNullable<MixParams['subtitle']>,
  token: CancelToken,
  ffmpeg: FFmpegService,
): Promise<string> {
  return ffmpeg.burnSubtitle(
    input,
    output,
    {
      subtitlePath: subtitle.srtPath,
      fontSize: subtitle.style?.fontSize,
      forceStyle: !!subtitle.style,
    },
    token,
  );
}

/**
 * 执行随机素材混剪
 * @param params 混剪参数
 * @param taskId 任务 ID(用于进度推送与 checkpoint)
 * @param token 取消令牌
 * @returns 混剪结果(输出路径、时长、片段数)
 */
export async function runRandomMix(
  params: MixParams,
  taskId: string,
  token: CancelToken,
  deps: RandomMixDeps = {},
): Promise<MixResult> {
  const ffmpeg = deps.ffmpeg ?? ffmpegService;
  const repo = deps.repo ?? materialRepo;
  const queue = deps.queue ?? taskQueue;
  const tracker = deps.tracker ?? usageTracker;

  // ===== 1. 参数校验(清单模式优先,PRD-v2.2 FR-4) =====
  const explicitPaths = (params.materialPaths ?? []).filter(
    (p) => typeof p === 'string' && p.trim().length > 0,
  );
  const explicitMode = explicitPaths.length > 0;
  if (!explicitMode && (!params.folderIds || params.folderIds.length === 0)) {
    throw new Error('[random-mixer] folderIds 不能为空');
  }
  const perFolderCount = params.perFolderCount ?? 0;
  if (!explicitMode && perFolderCount <= 0) {
    throw new Error('[random-mixer] perFolderCount 必须 > 0');
  }

  logger.info(
    explicitMode
      ? `[random-mixer] 任务 ${taskId} 开始: 清单模式, ${explicitPaths.length} 条显式素材`
      : `[random-mixer] 任务 ${taskId} 开始: ${params.folderIds.length} 个文件夹, 每文件夹 ${perFolderCount} 条`,
  );

  // 进度分配:抽取 10% → 切分 20% → 拼接 40% → 水印 15% → 字幕 15%
  // 各阶段内部按需细分;每完成一步保存 checkpoint

  // ===== 2. 创建工作目录 =====
  const workDir = await ensureWorkDir(taskId, deps);
  assertNotCancelled(token, taskId);

  // ===== 2.5 品牌套件(PRD-v1.7 FR-7):读取配置,补品牌水印,备好片头片尾 =====
  let brandConfig: BrandKitConfig | null = null;
  if (params.brandKit) {
    try {
      const cfg = brandStore.getConfig();
      if (hasBrandVisuals(cfg) || cfg.watermarkImage || cfg.introPath || cfg.outroPath) {
        brandConfig = cfg;
      }
    } catch (err) {
      logger.warn(
        `[random-mixer] 品牌套件配置读取失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!brandConfig) logger.info('[random-mixer] 品牌套件未配置任何项,跳过');
  }
  // params.watermark 未启用时应用品牌水印
  if (
    brandConfig?.watermarkImage &&
    !params.watermark?.enabled
  ) {
    params = {
      ...params,
      watermark: {
        enabled: true,
        type: 'image',
        content: brandConfig.watermarkImage,
        position: brandConfig.watermarkPosition ?? 'bottom-right',
        opacity: brandConfig.watermarkOpacity ?? 80,
        marginX: 20,
        marginY: 20,
      },
    };
  }

  // ===== 2.6 断点续渲染:加载 checkpoint 确定跳过哪些已完成步骤 =====
  let skipPick = false, skipConcat = false, skipScale = false, skipWatermark = false, skipSubtitle = false;
  let resumeFile = '';
  const cp = queue.loadCheckpoint(taskId);
  if (cp) {
    const ctx = cp.context as Record<string, unknown>;
    const isExistingFile = (f: unknown): f is string => typeof f === 'string' && f.length > 0 && existsSync(f);
    if (cp.step === 'random-finalize' && isExistingFile(ctx.finalPath)) {
      logger.info(`[random-mixer] 任务 ${taskId} checkpoint=finalize,直接返回`);
      const meta = await ffmpeg.probe(ctx.finalPath);
      return { outputPath: ctx.finalPath, durationSec: meta.durationSec, segmentCount: 0 };
    }
    if (cp.step === 'random-subtitle' && isExistingFile(ctx.currentFile)) {
      skipPick = skipConcat = skipScale = skipWatermark = skipSubtitle = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'random-watermark' && isExistingFile(ctx.currentFile)) {
      skipPick = skipConcat = skipScale = skipWatermark = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'random-scale' && isExistingFile(ctx.currentFile)) {
      skipPick = skipConcat = skipScale = true;
      resumeFile = ctx.currentFile;
    } else if (cp.step === 'random-concat' && isExistingFile(ctx.concatOutput)) {
      skipPick = skipConcat = true;
      resumeFile = ctx.concatOutput;
    }
    if (resumeFile) {
      logger.info(`[random-mixer] 任务 ${taskId} 从 checkpoint(step=${cp.step})续渲染`);
    }
  }

  // ===== 3. 抽取素材(清单模式优先,否则每个文件夹单点抽取,严格隔离) =====
  const allSegments: string[] = [];
  const usedPaths: string[] = [];
  if (!skipPick && explicitMode) {
    // ===== 3a. 清单模式(PRD-v2.2 FR-4):显式素材逐条参与(语义推荐/搜索命中) =====
    const segmentSec = params.segmentSec ?? 0;
    for (let j = 0; j < explicitPaths.length; j++) {
      assertNotCancelled(token, taskId);
      const p = explicitPaths[j];
      if (segmentSec > 0) {
        const segDir = join(workDir, `list_v${j}`);
        await mkdir(segDir, { recursive: true });
        const segs = await ffmpeg.split(
          p,
          segmentSec,
          segDir,
          { prefix: `seg_${j}_`, ext: 'mp4' },
          token,
        );
        allSegments.push(...segs);
      } else {
        allSegments.push(p);
      }
      usedPaths.push(p);
      // 进度:抽取阶段 0-10%
      queue.saveCheckpoint(taskId, 'random-pick', 10 * ((j + 1) / explicitPaths.length), {
        folderIndex: j,
        segments: allSegments.length,
      });
    }
  }
  const folderCount = explicitMode ? 0 : (params.folderIds?.length ?? 0);
  if (!skipPick && !explicitMode) {
  for (let i = 0; i < folderCount; i++) {
    const folderId = params.folderIds[i];
    assertNotCancelled(token, taskId);

    // 先 scanFolder 刷新素材列表
    await repo.scanFolder(folderId);
    // 单文件夹抽取 - 隔离 API
    const picked: MaterialMeta[] = repo.pickFromFolder(folderId, perFolderCount, {
      kind: 'video',
      unique: params.uniqueReuse ?? false,
    });

    // 防撞车(PRD-v1.7 FR-5):近 7 天已用素材警告 + 可选跳过
    let effective = picked;
    const recent = picked.filter((m) => tracker.isRecentlyUsed(m.path));
    if (recent.length > 0) {
      logger.warn(
        `[random-mixer] ${recent.length} 条素材近 7 天内已使用: ${recent.map((m) => m.path).join(', ')}`,
      );
      if (params.skipRecentUsed) {
        effective = picked.filter((m) => !tracker.isRecentlyUsed(m.path));
        logger.info(`[random-mixer] skipRecentUsed 已开启,跳过后实际使用 ${effective.length} 条`);
      }
    }

    // 对每个抽取的视频:若 segmentSec>0 则切短分段
    const segmentSec = params.segmentSec ?? 0;
    for (let j = 0; j < effective.length; j++) {
      assertNotCancelled(token, taskId);
      const mat = effective[j];
      if (segmentSec > 0) {
        // 切短分段:输出到 workDir/<folderId>_<j>/
        const segDir = join(workDir, `f${i}_v${j}`);
        await mkdir(segDir, { recursive: true });
        const segs = await ffmpeg.split(
          mat.path,
          segmentSec,
          segDir,
          { prefix: `seg_${i}_${j}_`, ext: 'mp4' },
          token,
        );
        // 若设置了 targetDurationSec>0,只取首段以满足总时长约束(简化版:取所有分段)
        allSegments.push(...segs);
      } else {
        // 不切分,直接用原视频
        allSegments.push(mat.path);
      }
      usedPaths.push(mat.path);
    }

    // 推送进度(抽取阶段 0-10%)
    const progress = 10 * ((i + 1) / folderCount);
    queue.saveCheckpoint(taskId, 'random-pick', progress, {
      folderIndex: i,
      segments: allSegments.length,
    });
  }
  } // end if (!skipPick)

  if (allSegments.length === 0 && !skipPick) {
    throw new Error('[random-mixer] 未抽取出任何视频片段,请检查文件夹素材');
  }

  logger.info(`[random-mixer] 共收集 ${allSegments.length} 个分段,开始拼接`);

  // ===== 3.5 品牌片头片尾:以分段形式拼入(异源走 filter concat,天然兼容) =====
  if (brandConfig && !skipConcat) {
    if (brandConfig.introPath && existsSync(brandConfig.introPath)) {
      allSegments.unshift(brandConfig.introPath);
      logger.info(`[random-mixer] 已拼入品牌片头: ${brandConfig.introPath}`);
    }
    if (brandConfig.outroPath && existsSync(brandConfig.outroPath)) {
      allSegments.push(brandConfig.outroPath);
      logger.info(`[random-mixer] 已拼入品牌片尾: ${brandConfig.outroPath}`);
    }
  }

  // ===== 4. 拼接所有分段(filter 模式,兼容异源;transitionSec>0 时启用 xfade 转场) =====
  assertNotCancelled(token, taskId);
  const concatOutput = join(workDir, 'concat.mp4');
  let currentFile: string;
  if (skipConcat) {
    currentFile = resumeFile;
    logger.info(`[random-mixer] 任务 ${taskId} 跳过 concat,使用 ${resumeFile}`);
  } else {
    const transitionSec = params.transitionSec ?? 0;
    await ffmpeg.concat(
      allSegments,
      concatOutput,
      {
        mode: 'filter',
        transitionSec: transitionSec > 0 ? transitionSec : undefined,
        transition: transitionSec > 0 ? 'fade' : undefined,
      },
      token,
    );
    queue.saveCheckpoint(taskId, 'random-concat', 40, { concatOutput });
    currentFile = concatOutput;
  }

  // ===== 5. 应用 scale + 品牌滤镜链统一画面(一次转码,不二次编码) =====
  assertNotCancelled(token, taskId);
  const scaleFilter = buildScaleFilter(params.resolution, params.keepOriginalQuality);
  const brandFilter = brandConfig ? buildBrandFilter(brandConfig) : '';
  const combinedVf = [scaleFilter, brandFilter].filter(Boolean).join(',');
  if (combinedVf.length > 0 && !skipScale) {
    // 通过 transcode 应用合并滤镜;使用 medium 预设平衡速度/质量
    const scaledOutput = join(workDir, 'scaled.mp4');
    await ffmpeg.transcode(
      currentFile,
      scaledOutput,
      {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
        extraOutputOptions: ['-vf', combinedVf],
      },
      token,
    );
    currentFile = scaledOutput;
    queue.saveCheckpoint(taskId, 'random-scale', 55, { currentFile });
  } else if (skipScale) {
    logger.info(`[random-mixer] 任务 ${taskId} 跳过 scale`);
  }

  // ===== 6. 应用水印(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.watermark?.enabled && !skipWatermark) {
    const wmOutput = join(workDir, 'watermarked.mp4');
    currentFile = await applyWatermarkIfNeeded(
      currentFile,
      wmOutput,
      params.watermark,
      token,
      ffmpeg,
    );
    queue.saveCheckpoint(taskId, 'random-watermark', 70, { currentFile });
  } else if (skipWatermark && params.watermark?.enabled) {
    logger.info(`[random-mixer] 任务 ${taskId} 跳过 watermark`);
  }

  // ===== 7. 烧录字幕(若启用) =====
  assertNotCancelled(token, taskId);
  if (params.subtitle?.srtPath && !skipSubtitle) {
    const subOutput = join(workDir, 'subtitle.mp4');
    currentFile = await burnSubtitleIfNeeded(
      currentFile,
      subOutput,
      params.subtitle,
      token,
      ffmpeg,
    );
    queue.saveCheckpoint(taskId, 'random-subtitle', 85, { currentFile });
  } else if (skipSubtitle && params.subtitle?.srtPath) {
    logger.info(`[random-mixer] 任务 ${taskId} 跳过 subtitle`);
  }

  // ===== 8. 输出到最终路径 =====
  assertNotCancelled(token, taskId);
  const finalName = (params.outputName ?? `mix-${Date.now()}.mp4`).trim();
  const finalPath = resolveExportPath(params.outputDir, finalName);
  // 通过 transcode 重封装到最终路径(避免文件跨卷移动问题)
  await ffmpeg.transcode(
    currentFile,
    finalPath,
    { videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' },
    token,
  );

  // 探测最终时长
  const meta = await ffmpeg.probe(finalPath);

  // 防撞车数据回流:成功产出后为所用素材累加使用计数(尽力而为,失败不阻断)
  if (usedPaths.length > 0) {
    try {
      tracker.record(usedPaths);
      logger.info(`[random-mixer] 已记录 ${usedPaths.length} 条素材使用`);
    } catch (err) {
      logger.warn(
        `[random-mixer] 素材使用记录失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  queue.saveCheckpoint(taskId, 'random-finalize', 100, { finalPath });
  logger.info(
    `[random-mixer] 任务 ${taskId} 完成: ${finalPath}, 时长 ${meta.durationSec}s`,
  );

  return {
    outputPath: finalPath,
    durationSec: meta.durationSec,
    segmentCount: allSegments.length,
  };
}
