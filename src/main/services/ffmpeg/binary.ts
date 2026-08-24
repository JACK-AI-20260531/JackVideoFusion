/**
 * FFmpeg 二进制检测
 * 启动时校验 ffmpeg / ffprobe 是否在 PATH(Windows 用 where,Unix 用 which),
 * 缺失则记录警告。检测到的路径会回写给 fluent-ffmpeg。
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '@main/utils/logger';

const execAsync = promisify(exec);

/**
 * 二进制检测结果
 */
export interface BinaryCheckResult {
  /** ffmpeg 是否可用 */
  ffmpeg: boolean;
  /** ffprobe 是否可用 */
  ffprobe: boolean;
  /** ffmpeg 可执行文件路径 */
  ffmpegPath?: string;
  /** ffprobe 可执行文件路径 */
  ffprobePath?: string;
}

/**
 * 解析 which/where 命令的 stdout,取首行非空路径(纯函数)
 * @param stdout 命令输出
 * @returns 首个命令路径,无有效行返回 null
 */
export function parseWhichOutput(stdout: string): string | null {
  const first = stdout.split(/\r?\n/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * 在 PATH 中查找命令路径
 * Windows 使用 where,其它平台使用 which
 * @param cmd 命令名,如 ffmpeg
 * @returns 命令绝对路径,未找到返回 null
 */
async function which(cmd: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execAsync(`${finder} ${cmd}`);
    return parseWhichOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * 检测 ffmpeg / ffprobe 是否可用
 * 缺失时仅记录警告,不抛异常(由调用方决定是否阻断)
 * @returns 二进制检测结果
 */
export async function detectFfmpegBinaries(): Promise<BinaryCheckResult> {
  const ffmpegPath = await which('ffmpeg');
  const ffprobePath = await which('ffprobe');

  if (!ffmpegPath) {
    logger.warn('[FFmpeg] 未在 PATH 中找到 ffmpeg,视频处理功能将不可用');
  }
  if (!ffprobePath) {
    logger.warn('[FFmpeg] 未在 PATH 中找到 ffprobe,元数据探测功能将不可用');
  }
  if (ffmpegPath && ffprobePath) {
    logger.info(`[FFmpeg] 二进制检测成功: ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
  }

  return {
    ffmpeg: !!ffmpegPath,
    ffprobe: !!ffprobePath,
    ffmpegPath: ffmpegPath ?? undefined,
    ffprobePath: ffprobePath ?? undefined,
  };
}
