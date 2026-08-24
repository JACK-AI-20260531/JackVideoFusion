/**
 * FFmpeg 服务统一封装
 *
 * 在 fluent-ffmpeg 之上提供原子能力:
 *   probe / getMetadata / getDuration
 *   split / extractFrames / concat / remux / transcode
 *   applyWatermark / burnSubtitle / stripAudio / cancel
 *
 * 设计约定:
 *   - 方法成功返回结构化数据,失败抛 FFmpegError(含 stderr 摘要)
 *   - 长任务支持 CancelToken 取消(通过 task-registry 中断子进程)
 *   - 进度通过 emitProgress 推送到渲染层 'ffmpeg:progress' 频道
 *   - IPC 层(safeHandle 等价包装)负责把返回值/异常转成 { ok, data, error }
 */
import { tmpdir } from 'os';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@main/utils/logger';
import { emitProgress } from './progress';
import { taskRegistry } from './task-registry';
import { detectFfmpegBinaries, type BinaryCheckResult } from './binary';
import { extractSubtitleStreams } from './subtitle-stream';
import { buildSegmentOutputOptions } from './split-options';
import {
  FFmpegError,
  CancelToken,
  generateTaskId,
  type VideoMeta,
  type SplitOpts,
  type ExtractFramesOpts,
  type ConcatOpts,
  type RemuxOpts,
  type TranscodeOpts,
  type WatermarkOpts,
  type BurnSubtitleOpts,
  type WatermarkPosition,
  type XfadeTransition,
} from './types';

/** fluent-ffmpeg 命令实例类型 */
type FFCommand = ReturnType<typeof ffmpeg>;

/** 二进制检测缓存(进程内只检测一次) */
let binaryCheckPromise: Promise<BinaryCheckResult> | null = null;

/**
 * 确保 ffmpeg / ffprobe 二进制可用,并回写路径到 fluent-ffmpeg
 * 首次调用触发检测,后续复用缓存结果
 */
async function ensureBinaries(): Promise<BinaryCheckResult> {
  if (!binaryCheckPromise) {
    binaryCheckPromise = detectFfmpegBinaries();
  }
  const result = await binaryCheckPromise;
  if (result.ffmpegPath) ffmpeg.setFfmpegPath(result.ffmpegPath);
  if (result.ffprobePath) ffmpeg.setFfprobePath(result.ffprobePath);
  if (!result.ffmpeg) {
    throw new FFmpegError('未找到 ffmpeg 二进制,请安装 ffmpeg 或将其加入 PATH', {
      code: 'FFMPEG_NOT_FOUND',
    });
  }
  return result;
}

/**
 * 确保目录存在(递归创建)
 * @param dir 目录路径
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * 解析帧率字符串(如 "30/1" / "30000/1001")为数值
 * @param rate 帧率表达式
 * @returns 帧率数值,无法解析返回 undefined
 */
export function parseFps(rate?: string): number | undefined {
  if (!rate) return undefined;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isNaN(num) && !isNaN(den) && den !== 0) {
      return num / den;
    }
  }
  const n = parseFloat(rate);
  return isNaN(n) ? undefined : n;
}

/**
 * 列出目录下指定前缀与扩展名的文件(已排序)
 * @param dir 目录路径
 * @param prefix 文件名前缀
 * @param ext 扩展名(不含点)
 * @returns 完整文件路径数组
 */
async function listOutputFiles(dir: string, prefix: string, ext: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(`.${ext}`))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * 转义滤镜中的文件路径(反斜杠转正斜杠,冒号转义)
 * 用于 subtitles / drawtext 的 textfile / fontfile 等滤镜参数
 * @param p 原始路径
 * @returns 转义后路径
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * 运行 fluent-ffmpeg 命令并包装为 Promise
 * 统一处理进度推送、取消与错误转换
 * @param cmd fluent-ffmpeg 命令实例
 * @param opts 任务上下文(taskId / stage / 输入输出 / token)
 */
function runCommand(
  cmd: FFCommand,
  opts: {
    taskId: string;
    stage: string;
    input?: string;
    output?: string;
    token?: CancelToken;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { taskId, stage, token } = opts;

    // 启动前检查是否已取消
    if (token?.cancelled) {
      reject(new FFmpegError('任务已取消', { code: 'CANCELLED', taskId }));
      return;
    }

    // 注册取消器:标记 token + kill 子进程
    if (token) {
      taskRegistry.register(token.id, () => {
        token.cancel();
        try {
          cmd.kill('SIGKILL');
        } catch {
          /* 忽略 kill 异常 */
        }
      });
    }

    cmd
      .on('progress', (progress: { percent?: number; timemark?: string }) => {
        // 已取消则不再推送进度
        if (token?.cancelled) return;
        const raw = typeof progress.percent === 'number' ? progress.percent : NaN;
        const percent = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
        emitProgress({
          taskId,
          stage,
          percent,
          timemark: progress.timemark,
          input: opts.input,
          output: opts.output,
        });
      })
      .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
        if (token) taskRegistry.unregister(token.id);
        if (token?.cancelled) {
          reject(new FFmpegError('任务已取消', { code: 'CANCELLED', taskId, stderr: stderr ?? undefined }));
        } else {
          reject(
            new FFmpegError(err.message, {
              code: 'FFMPEG_RUN_ERROR',
              stderr: stderr ?? undefined,
              taskId,
            }),
          );
        }
      })
      .on('end', () => {
        if (token) taskRegistry.unregister(token.id);
        resolve();
      })
      .run();
  });
}

/**
 * 解析任务 ID:优先用 token.id,否则生成新 ID
 * @param token 取消令牌
 * @param prefix 自动生成时的前缀
 */
function resolveTaskId(token?: CancelToken, prefix = 'task'): string {
  return token ? token.id : generateTaskIdWithPrefix(prefix);
}

/**
 * 带前缀生成任务 ID
 * @param prefix 前缀
 */
function generateTaskIdWithPrefix(prefix: string): string {
  return `${prefix}-${generateTaskId()}`;
}

/**
 * FFmpeg 服务接口
 * 所有原子方法的签名集合,IPC 层与上层模块依赖此契约
 */
export interface FFmpegService {
  /** 探测文件元数据(时长/分辨率/编码) */
  probe(filePath: string): Promise<VideoMeta>;
  /** 获取元数据(probe 别名) */
  getMetadata(filePath: string): Promise<VideoMeta>;
  /** 仅获取时长(秒) */
  getDuration(filePath: string): Promise<number>;
  /** 按时长分割视频为多段 */
  split(
    input: string,
    segmentSec: number,
    outputDir: string,
    opts?: SplitOpts,
    token?: CancelToken,
  ): Promise<string[]>;
  /** 抽帧 */
  extractFrames(
    input: string,
    outputDir: string,
    opts?: ExtractFramesOpts,
    token?: CancelToken,
  ): Promise<string[]>;
  /** 拼接多视频 */
  concat(inputs: string[], output: string, opts?: ConcatOpts, token?: CancelToken): Promise<string>;
  /** 重封装(换容器,不重编码) */
  remux(input: string, output: string, opts: RemuxOpts, token?: CancelToken): Promise<string>;
  /** 转码 */
  transcode(
    input: string,
    output: string,
    opts?: TranscodeOpts,
    token?: CancelToken,
  ): Promise<string>;
  /** 添加水印(图片 / 文本) */
  applyWatermark(
    input: string,
    output: string,
    opts: WatermarkOpts,
    token?: CancelToken,
  ): Promise<string>;
  /** 烧录字幕 */
  burnSubtitle(
    input: string,
    output: string,
    opts: BurnSubtitleOpts,
    token?: CancelToken,
  ): Promise<string>;
  /** 去除音轨 */
  stripAudio(input: string, output: string, token?: CancelToken): Promise<string>;
  /** 取消指定任务 */
  cancel(tokenId: string): boolean;
  /** 检测 ffmpeg / ffprobe 二进制可用性 */
  detectBinaries(): Promise<BinaryCheckResult>;
}

/**
 * 探测文件元数据
 * @param filePath 媒体文件路径
 * @returns 视频元数据
 */
async function probe(filePath: string): Promise<VideoMeta> {
  await ensureBinaries();
  return new Promise<VideoMeta>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        reject(
          new FFmpegError(`探测失败: ${err.message}`, { code: 'FFPROBE_ERROR' }),
        );
        return;
      }
      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');
      const durationSec =
        typeof data.format.duration === 'number'
          ? data.format.duration
          : data.format.duration
            ? parseFloat(data.format.duration)
            : 0;
      const meta: VideoMeta = {
        filePath,
        durationSec: isNaN(durationSec) ? 0 : durationSec,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        fps: parseFps(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
        bitrate:
          typeof data.format.bit_rate === 'number'
            ? data.format.bit_rate
            : data.format.bit_rate
              ? parseInt(data.format.bit_rate, 10)
              : undefined,
        sizeBytes:
          typeof data.format.size === 'number'
            ? data.format.size
            : data.format.size
              ? Number(data.format.size)
              : undefined,
        format: data.format.format_name,
        subtitleStreams: extractSubtitleStreams(data),
      };
      resolve(meta);
    });
  });
}

/**
 * 按时长分割视频为多段
 * 默认走关键帧快速分割(-c copy),precise=true 时重编码以保证精确切点
 * @param input 输入文件
 * @param segmentSec 每段时长(秒)
 * @param outputDir 输出目录
 * @param opts 分割选项
 * @param token 取消令牌
 * @returns 输出文件路径数组
 */
async function split(
  input: string,
  segmentSec: number,
  outputDir: string,
  opts?: SplitOpts,
  token?: CancelToken,
): Promise<string[]> {
  await ensureBinaries();
  await ensureDir(outputDir);

  const ext = opts?.ext ?? 'mp4';
  const prefix = opts?.prefix ?? 'segment_';
  const precise = opts?.precise ?? false;
  const taskId = resolveTaskId(token, 'split');
  const pattern = join(outputDir, `${prefix}%03d.${ext}`);

  // 使用 segment 分离器;非 precise 模式直接流复制
  const cmd = ffmpeg(input);
  const outputOptions = [
    '-f',
    'segment',
    '-segment_time',
    String(segmentSec),
    '-reset_timestamps',
    '1',
    ...buildSegmentOutputOptions({ precise, stripAudio: opts?.stripAudio }),
  ];
  cmd.outputOptions(outputOptions);
  cmd.output(pattern);

  logger.info(`[FFmpeg] split 开始: input=${input} segmentSec=${segmentSec} -> ${pattern}`);
  await runCommand(cmd, { taskId, stage: 'split', input, output: pattern, token });

  const files = await listOutputFiles(outputDir, prefix, ext);
  logger.info(`[FFmpeg] split 完成: 生成 ${files.length} 个分段`);
  return files;
}

/**
 * 抽帧
 * 支持三种模式:fps(每秒 N 帧)/ interval(每 N 秒一帧)/ count(全片均匀 N 帧)
 * @param input 输入视频
 * @param outputDir 输出目录
 * @param opts 抽帧选项
 * @param token 取消令牌
 * @returns 输出图片路径数组
 */
async function extractFrames(
  input: string,
  outputDir: string,
  opts?: ExtractFramesOpts,
  token?: CancelToken,
): Promise<string[]> {
  await ensureBinaries();
  await ensureDir(outputDir);

  const mode = opts?.mode ?? 'fps';
  const value = opts?.value ?? 1;
  const prefix = opts?.prefix ?? 'frame_';
  const format = opts?.format ?? 'jpg';
  const taskId = resolveTaskId(token, 'extractFrames');
  const pattern = join(outputDir, `${prefix}%04d.${format}`);

  // 构造视频滤镜
  const vfParts: string[] = [];
  if (opts?.width && opts.width > 0) {
    vfParts.push(`scale=${opts.width}:-1`);
  }
  if (mode === 'fps') {
    vfParts.push(`fps=${value}`);
  } else if (mode === 'interval') {
    vfParts.push(`fps=1/${value}`);
  } else if (mode === 'count') {
    // count 模式需要总时长来计算目标帧率
    const meta = await probe(input);
    const fps = value / Math.max(meta.durationSec, 0.001);
    vfParts.push(`fps=${fps}`);
  }
  const vf = vfParts.join(',');

  const cmd = ffmpeg(input);
  if (vf.length > 0) cmd.videoFilters(vf);
  cmd.noAudio();
  cmd.output(pattern);

  logger.info(`[FFmpeg] extractFrames 开始: input=${input} mode=${mode} -> ${pattern}`);
  await runCommand(cmd, { taskId, stage: 'extractFrames', input, output: pattern, token });

  const files = await listOutputFiles(outputDir, prefix, format);
  logger.info(`[FFmpeg] extractFrames 完成: 生成 ${files.length} 张帧`);
  return files;
}

/**
 * 拼接多视频
 * demuxer 模式:concat 分离器 + 流复制,速度快,要求同源同编码
 * filter 模式:concat 滤镜,重编码,兼容异源
 * 当 opts.transitionSec>0 且 mode='filter' 且输入≥2 时,改走 concatWithXfade 实现转场淡化
 * @param inputs 输入文件数组
 * @param output 输出文件路径
 * @param opts 拼接选项
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function concat(
  inputs: string[],
  output: string,
  opts?: ConcatOpts,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  if (!inputs.length) {
    throw new FFmpegError('拼接输入为空', { code: 'INVALID_INPUT' });
  }
  await ensureDir(join(output, '..'));

  const mode = opts?.mode ?? 'demuxer';
  const transitionSec = opts?.transitionSec ?? 0;
  const taskId = resolveTaskId(token, 'concat');

  // 转场淡化路由:仅在 filter 模式 + transitionSec>0 + 输入≥2 时启用
  if (transitionSec > 0) {
    if (mode === 'demuxer') {
      logger.warn(
        `[FFmpeg] concat: transitionSec=${transitionSec} 在 demuxer 模式下不支持,已忽略并降级为无转场`,
      );
    } else if (inputs.length < 2) {
      logger.warn(
        `[FFmpeg] concat: transitionSec=${transitionSec} 但输入仅 ${inputs.length} 个,无需转场`,
      );
    } else {
      return concatWithXfade(
        inputs,
        output,
        transitionSec,
        opts?.transition ?? 'fade',
        token,
      );
    }
  }

  if (mode === 'demuxer') {
    // 生成 concat 列表文件
    const listFile = join(tmpdir(), `jvf_concat_${taskId}.txt`);
    const lines = inputs.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await writeFile(listFile, lines.join('\n'), 'utf8');

    const cmd = ffmpeg(listFile);
    cmd.inputOptions(['-f', 'concat', '-safe', '0']);
    cmd.outputOptions(['-c', 'copy']);
    cmd.output(output);

    logger.info(`[FFmpeg] concat(demuxer) 开始: ${inputs.length} 个文件 -> ${output}`);
    await runCommand(cmd, { taskId, stage: 'concat', input: listFile, output, token });
    return output;
  }

  // filter 模式:concat 滤镜(重编码)
  const filter = `concat=n=${inputs.length}:v=1:a=1`;
  const cmd = ffmpeg();
  for (const p of inputs) cmd.input(p);
  cmd.complexFilter(filter);
  cmd.output(output);

  logger.info(`[FFmpeg] concat(filter) 开始: ${inputs.length} 个文件 -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'concat', output, token });
  return output;
}

/**
 * 带转场淡化的拼接(xfade 滤镜链)
 * 适合需要平滑过渡的场景,要求重编码,计算开销较大
 *
 * 链式调用原理:
 *   视频链:[0:v][1:v] xfade=transition=T:duration=D:offset=O0 [vx0]
 *          [vx0][2:v] xfade=transition=T:duration=D:offset=O1 [vx1]
 *          ...
 *   音频链:[0:a][1:a] acrossfade=d=D [ax0]
 *          [ax0][2:a] acrossfade=d=D [ax1]
 *          ...
 *   offset_i = sum(duration_0..i) - D * (i+1)
 *
 * 边缘处理:
 *   - 单输入直接退化为 transcode 重封装
 *   - 输入无音轨时 ffmpeg 会失败,调用方需先确保所有输入含音轨
 *     (random-mixer 默认保留原音轨,audio-matcher 在 stripAudio=false 时也保留)
 *
 * @param inputs 输入视频文件数组(长度 ≥ 2)
 * @param output 输出文件路径
 * @param transitionSec 转场时长(秒)
 * @param transition 转场类型,默认 'fade'
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function concatWithXfade(
  inputs: string[],
  output: string,
  transitionSec: number,
  transition: XfadeTransition,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  if (inputs.length < 2) {
    // 单输入直接走 transcode 重封装
    const taskIdSingle = resolveTaskId(token, 'xfade');
    const cmdSingle = ffmpeg(inputs[0]);
    cmdSingle.outputOptions(['-c', 'copy']);
    cmdSingle.output(output);
    logger.info(`[FFmpeg] concatWithXfade(单输入降级): ${inputs[0]} -> ${output}`);
    await runCommand(cmdSingle, {
      taskId: taskIdSingle,
      stage: 'xfade',
      input: inputs[0],
      output,
      token,
    });
    return output;
  }

  const taskId = resolveTaskId(token, 'xfade');
  await ensureDir(join(output, '..'));

  // 探测每个输入时长,用于计算 xfade offset
  const durations: number[] = [];
  for (const p of inputs) {
    const meta = await probe(p);
    durations.push(meta.durationSec);
  }

  // 构建 complexFilter 字符串数组
  // 视频与音频各自链式 xfade / acrossfade
  const filters: string[] = [];
  let lastV = '0:v';
  let lastA = '0:a';
  let cumulativeDuration = durations[0];

  for (let i = 1; i < inputs.length; i++) {
    // offset = 前面所有视频累计时长 - (i * transitionSec)
    // 减去 i*transitionSec 是因为每次转场会"吃掉" transitionSec 时长
    const offset = Math.max(0, cumulativeDuration - transitionSec * i);
    const isLast = i === inputs.length - 1;
    const vLabel = isLast ? 'vout' : `vx${i}`;
    const aLabel = isLast ? 'aout' : `ax${i}`;
    filters.push(
      `[${lastV}][${i}:v]xfade=transition=${transition}:duration=${transitionSec}:offset=${offset.toFixed(3)}[${vLabel}]`,
    );
    filters.push(`[${lastA}][${i}:a]acrossfade=d=${transitionSec}[${aLabel}]`);
    lastV = vLabel;
    lastA = aLabel;
    cumulativeDuration += durations[i];
  }

  const cmd = ffmpeg();
  for (const p of inputs) cmd.input(p);
  cmd.complexFilter(filters);
  cmd.outputOptions(['-map', '[vout]', '-map', '[aout]']);
  cmd.output(output);

  logger.info(
    `[FFmpeg] concatWithXfade 开始: ${inputs.length} 个文件, 转场 ${transition}=${transitionSec}s -> ${output}`,
  );
  await runCommand(cmd, { taskId, stage: 'xfade', output, token });
  return output;
}

/**
 * 重封装:仅更换容器,不重编码(流复制)
 * @param input 输入文件
 * @param output 输出文件路径
 * @param opts 重封装选项(目标格式)
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function remux(
  input: string,
  output: string,
  opts: RemuxOpts,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  await ensureDir(join(output, '..'));
  const taskId = resolveTaskId(token, 'remux');

  const cmd = ffmpeg(input);
  cmd.outputOptions(['-c', 'copy']);
  cmd.format(opts.format);
  cmd.output(output);

  logger.info(`[FFmpeg] remux 开始: input=${input} format=${opts.format} -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'remux', input, output, token });
  return output;
}

/**
 * 转码
 * @param input 输入文件
 * @param output 输出文件路径
 * @param opts 转码选项
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function transcode(
  input: string,
  output: string,
  opts?: TranscodeOpts,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  await ensureDir(join(output, '..'));
  const taskId = resolveTaskId(token, 'transcode');

  const cmd = ffmpeg(input);
  cmd.videoCodec(opts?.videoCodec ?? 'libx264');
  cmd.audioCodec(opts?.audioCodec ?? 'aac');
  if (opts?.videoBitrate) cmd.videoBitrate(opts.videoBitrate);
  if (opts?.audioBitrate) cmd.audioBitrate(opts.audioBitrate);
  if (opts?.resolution) cmd.size(opts.resolution);
  if (opts?.fps) cmd.fps(opts.fps);
  if (opts?.preset) cmd.outputOptions(['-preset', opts.preset]);
  if (opts?.format) cmd.format(opts.format);
  if (opts?.extraOutputOptions?.length) cmd.outputOptions(opts.extraOutputOptions);
  cmd.output(output);

  logger.info(`[FFmpeg] transcode 开始: input=${input} -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'transcode', input, output, token });
  return output;
}

/**
 * 构造图片水印 overlay 位置表达式(基于主视频 W/H 与水印 w/h)
 * @param pos 位置枚举
 * @param mx 水平边距
 * @param my 垂直边距
 * @returns { x, y } 位置表达式
 */
export function buildOverlayPosition(
  pos: WatermarkPosition,
  mx: number,
  my: number,
): { x: string; y: string } {
  switch (pos) {
    case 'left-top':
      return { x: `${mx}`, y: `${my}` };
    case 'left-center':
      return { x: `${mx}`, y: '(H-h)/2' };
    case 'left-bottom':
      return { x: `${mx}`, y: `H-h-${my}` };
    case 'center-top':
      return { x: '(W-w)/2', y: `${my}` };
    case 'center':
      return { x: '(W-w)/2', y: '(H-h)/2' };
    case 'center-bottom':
      return { x: '(W-w)/2', y: `H-h-${my}` };
    case 'right-top':
      return { x: `W-w-${mx}`, y: `${my}` };
    case 'right-center':
      return { x: `W-w-${mx}`, y: '(H-h)/2' };
    case 'right-bottom':
    default:
      return { x: `W-w-${mx}`, y: `H-h-${my}` };
  }
}

/**
 * 构造文本水印 drawtext 位置表达式(基于 w/h 与 text_w/text_h)
 * @param pos 位置枚举
 * @param mx 水平边距
 * @param my 垂直边距
 * @returns { x, y } 位置表达式
 */
export function buildDrawtextPosition(
  pos: WatermarkPosition,
  mx: number,
  my: number,
): { x: string; y: string } {
  switch (pos) {
    case 'left-top':
      return { x: `${mx}`, y: `${my}` };
    case 'left-center':
      return { x: `${mx}`, y: '(h-text_h)/2' };
    case 'left-bottom':
      return { x: `${mx}`, y: `h-text_h-${my}` };
    case 'center-top':
      return { x: '(w-text_w)/2', y: `${my}` };
    case 'center':
      return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
    case 'center-bottom':
      return { x: '(w-text_w)/2', y: `h-text_h-${my}` };
    case 'right-top':
      return { x: `w-text_w-${mx}`, y: `${my}` };
    case 'right-center':
      return { x: `w-text_w-${mx}`, y: '(h-text_h)/2' };
    case 'right-bottom':
    default:
      return { x: `w-text_w-${mx}`, y: `h-text_h-${my}` };
  }
}

/**
 * 添加水印(图片或文本)
 * 图片水印使用 overlay 滤镜,文本水印使用 drawtext 滤镜
 * @param input 输入视频
 * @param output 输出文件路径
 * @param opts 水印选项
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function applyWatermark(
  input: string,
  output: string,
  opts: WatermarkOpts,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  await ensureDir(join(output, '..'));
  const taskId = resolveTaskId(token, 'watermark');

  const position = opts.position ?? 'right-bottom';
  const mx = opts.marginX ?? 20;
  const my = opts.marginY ?? 20;

  if (opts.type === 'image') {
    if (!opts.image) {
      throw new FFmpegError('图片水印缺少 image 路径', { code: 'INVALID_INPUT', taskId });
    }
    const scale = opts.scale ?? 1;
    const pos = buildOverlayPosition(position, mx, my);
    // 缩放水印后 overlay 到主视频
    const filter = `[1:v]scale=iw*${scale}:-1[wm];[0:v][wm]overlay=${pos.x}:${pos.y}`;
    const cmd = ffmpeg();
    cmd.input(input);
    cmd.input(opts.image);
    cmd.complexFilter(filter);
    cmd.output(output);

    logger.info(`[FFmpeg] applyWatermark(image) 开始: input=${input} -> ${output}`);
    await runCommand(cmd, { taskId, stage: 'applyWatermark', input, output, token });
    return output;
  }

  // 文本水印:写入临时文本文件,用 drawtext 的 textfile 引用,规避特殊字符转义难题
  if (!opts.text) {
    throw new FFmpegError('文本水印缺少 text 内容', { code: 'INVALID_INPUT', taskId });
  }
  const textFile = join(tmpdir(), `jvf_wm_${taskId}.txt`);
  await writeFile(textFile, opts.text, 'utf8');

  const pos = buildDrawtextPosition(position, mx, my);
  const fontSize = opts.fontSize ?? 24;
  const fontColor = opts.fontColor ?? 'white';
  const parts = [
    `drawtext=textfile='${escapeFilterPath(textFile)}'`,
    `fontcolor=${fontColor}`,
    `fontsize=${fontSize}`,
    `x=${pos.x}`,
    `y=${pos.y}`,
  ];
  if (opts.fontFile) {
    parts.push(`fontfile='${escapeFilterPath(opts.fontFile)}'`);
  }
  const drawtext = parts.join(':');

  const cmd = ffmpeg(input);
  cmd.videoFilters(drawtext);
  cmd.output(output);

  logger.info(`[FFmpeg] applyWatermark(text) 开始: input=${input} -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'applyWatermark', input, output, token });
  return output;
}

/**
 * 烧录字幕(将字幕硬编码到画面)
 * @param input 输入视频
 * @param output 输出文件路径
 * @param opts 字幕选项
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function burnSubtitle(
  input: string,
  output: string,
  opts: BurnSubtitleOpts,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  await ensureDir(join(output, '..'));
  const taskId = resolveTaskId(token, 'burnSubtitle');

  // subtitles 滤镜;forceStyle 时附加 ForceSize 样式
  let filter = `subtitles='${escapeFilterPath(opts.subtitlePath)}'`;
  if (opts.forceStyle) {
    const fontSize = opts.fontSize ?? 24;
    filter += `:force_style='FontSize=${fontSize}'`;
  }

  const cmd = ffmpeg(input);
  cmd.videoFilters(filter);
  cmd.output(output);

  logger.info(`[FFmpeg] burnSubtitle 开始: input=${input} sub=${opts.subtitlePath} -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'burnSubtitle', input, output, token });
  return output;
}

/**
 * 去除音轨(流复制视频)
 * @param input 输入视频
 * @param output 输出文件路径
 * @param token 取消令牌
 * @returns 输出文件路径
 */
async function stripAudio(
  input: string,
  output: string,
  token?: CancelToken,
): Promise<string> {
  await ensureBinaries();
  await ensureDir(join(output, '..'));
  const taskId = resolveTaskId(token, 'stripAudio');

  const cmd = ffmpeg(input);
  cmd.noAudio();
  cmd.outputOptions(['-c:v', 'copy']);
  cmd.output(output);

  logger.info(`[FFmpeg] stripAudio 开始: input=${input} -> ${output}`);
  await runCommand(cmd, { taskId, stage: 'stripAudio', input, output, token });
  return output;
}

/**
 * 取消指定任务
 * @param tokenId 令牌 ID
 * @returns 是否成功触发取消
 */
function cancel(tokenId: string): boolean {
  return taskRegistry.cancel(tokenId);
}

/** FFmpeg 服务单例(导出供 IPC 层与上层模块调用) */
export const ffmpegService: FFmpegService = {
  probe,
  getMetadata: probe,
  getDuration: async (filePath: string) => (await probe(filePath)).durationSec,
  split,
  extractFrames,
  concat,
  remux,
  transcode,
  applyWatermark,
  burnSubtitle,
  stripAudio,
  cancel,
  detectBinaries: detectFfmpegBinaries,
};
