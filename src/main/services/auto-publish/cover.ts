/**
 * 智能封面生成(PRD-发布闭环与素材兜底 FR-2)
 *
 * 职责:
 *   - 从视频 25%/50%/75% 处抽帧,取中间帧(50%)作为封面底图
 *   - 叠加封面文案(白字黑边,复用 applyWatermark 文本管线,零外部 API)
 *   - 纯函数(抽帧时刻/文案截断/文件名)与编排分离,纯函数可独立单测
 */
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { copyFileSync, existsSync, rmSync } from 'fs';
import { ffmpegService } from '../ffmpeg';
import { logger } from '../../utils/logger';

/** 封面文案默认最大长度(字符) */
export const COVER_TEXT_MAX_LEN = 16;

/** 封面文件名前缀 */
const COVER_PREFIX = 'cover-';

/**
 * 计算候选抽帧时刻(25%/50%/75% 三处)
 * @param durationSec 视频时长(秒)
 * @returns 抽帧时刻数组(秒,升序)
 */
export function pickFrameTimes(durationSec: number): number[] {
  if (durationSec <= 0) return [0];
  return [durationSec * 0.25, durationSec * 0.5, durationSec * 0.75];
}

/**
 * 截断封面文案(超长以省略号结尾)
 * @param text 原始文案
 * @param maxLen 最大长度,默认 16
 * @returns 截断后的文案
 */
export function truncateCoverText(text: string, maxLen = COVER_TEXT_MAX_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

/**
 * 由视频路径生成封面文件名(cover-<视频名>.jpg,与视频同目录)
 * @param videoPath 视频绝对路径
 * @returns 封面输出绝对路径
 */
export function buildCoverPath(videoPath: string): string {
  const name = basename(videoPath).replace(/\.[^.]+$/, '');
  return join(dirname(videoPath), `${COVER_PREFIX}${name}.jpg`);
}

/**
 * 查找系统中文字体(封面文字渲染需要;缺失时 ffmpeg 走默认字体,中文可能显示为方块)
 * @param fontsDir 字体目录(默认 Windows Fonts;测试可注入临时目录)
 * @returns 字体文件绝对路径;未找到返回 null
 */
export function findChineseFontFile(fontsDir = 'C:\\Windows\\Fonts'): string | null {
  const candidates = ['msyh.ttc', 'simhei.ttf', 'simsun.ttc', 'msyhbd.ttc'];
  for (const candidate of candidates) {
    const p = join(fontsDir, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

/** generateCover 选项 */
export interface GenerateCoverOptions {
  /** 封面文案(可空;为空则只出纯帧封面) */
  coverText?: string;
  /** 输出目录(默认与视频同目录) */
  outputDir?: string;
  /** 字体文件路径(默认自动查找系统中文字体) */
  fontFile?: string;
}

/**
 * 生成智能封面(编排)
 * 流程:probe 时长 → interval 抽帧(0/25/50/75%) → 取 50% 帧 → 文字叠加
 * 抽帧临时目录用后即删;任一步失败向上抛错,由调用方降级
 * @param videoPath 视频绝对路径
 * @param opts 选项
 * @returns 封面图绝对路径
 */
export async function generateCover(
  videoPath: string,
  opts: GenerateCoverOptions = {},
): Promise<string> {
  const durationSec = await ffmpegService.getDuration(videoPath);

  // interval = 时长/4 → 抽出 0/25/50/75% 四帧
  const workDir = join(tmpdir(), `jvf-cover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  let srcFrame: string | null = null;
  try {
    const frames = await ffmpegService.extractFrames(videoPath, workDir, {
      mode: 'interval',
      value: Math.max(durationSec / 4, 0.1),
      prefix: 'frame_',
      format: 'jpg',
    });
    if (frames.length === 0) {
      throw new Error('封面抽帧失败:未产出任何帧');
    }
    // 帧按序对应 0/25/50/75%,取 50% 帧(index 2);帧不足时取中间帧
    const midIndex = Math.min(2, frames.length - 1);
    srcFrame = frames[midIndex];

    const outPath = opts.outputDir
      ? join(opts.outputDir, `${COVER_PREFIX}${basename(videoPath).replace(/\.[^.]+$/, '')}.jpg`)
      : buildCoverPath(videoPath);

    const coverText = truncateCoverText(opts.coverText ?? '');
    if (coverText.length > 0) {
      const fontFile = opts.fontFile ?? findChineseFontFile() ?? undefined;
      // 字号按时长无关、按常见 720p-1080p 取中值,保证小图不溢出
      await ffmpegService.applyWatermark(srcFrame, outPath, {
        type: 'text',
        text: coverText,
        position: 'center-bottom',
        fontSize: 48,
        fontColor: 'white',
        borderWidth: 3,
        borderColor: 'black',
        fontFile,
      });
    } else {
      // 无文案:直接把抽出的帧复制为封面
      copyFileSync(srcFrame, outPath);
    }
    logger.info(`[cover] 封面生成完成: ${outPath}`);
    return outPath;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 清理失败可忽略 */
    }
  }
}
