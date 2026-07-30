/**
 * 素材处理服务
 * 职责:文本分割(纯 Node 字符串处理)、字幕提取(调用 ffmpeg -map 0:s:0)
 * 依赖:child_process(execFile) 调用系统 ffmpeg;logger 记录日志
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger';

// promisify execFile,获得 Promise 风格的异步执行
const execFileAsync = promisify(execFile);

// 全部标点(中英文),用于非保留标点模式时剔除
const ALL_PUNCT_REGEX = /[，。！？；：、""''（）《》【】,.!?;:"'()<>[\]{}…—\-]/g;

/**
 * 文本分割:按字数切分,支持标点感知和自动分段
 * 算法:1) 按段落拆分(可选) → 2) 按句末标点拆句 → 3) 贪心打包至 charLimit → 4) 标点处理
 * @param text 原始文本
 * @param charLimit 单条最大字数(>0)
 * @param opts.keepPunct 是否保留标点
 * @param opts.autoParagraph 是否按段落自动分段
 * @returns 分割后的文本数组(已去空串)
 */
export function splitText(
  text: string,
  charLimit: number,
  opts: { keepPunct: boolean; autoParagraph: boolean },
): string[] {
  // 入参校验
  if (!text || charLimit <= 0) return [];

  // 第1步:按段落拆分(autoParagraph 模式下以换行为段落边界)
  const paragraphs = opts.autoParagraph
    ? text.split(/\n+/).filter((p) => p.trim().length > 0)
    : [text];

  // 第2步:按句末标点拆分句子,保留标点(lookbehind 保证标点附在句尾)
  const sentences: string[] = [];
  for (const para of paragraphs) {
    const parts = para.split(/(?<=[。！？!?.…])/).filter((s) => s.trim().length > 0);
    for (const part of parts) {
      if (part.length <= charLimit) {
        sentences.push(part);
      } else {
        // 单句超长时按 charLimit 硬切分
        for (let i = 0; i < part.length; i += charLimit) {
          sentences.push(part.slice(i, i + charLimit));
        }
      }
    }
  }

  // 第3步:贪心打包,将句子组合到不超过 charLimit 的片段中
  const segments: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length <= charLimit) {
      current += sentence;
    } else {
      if (current) segments.push(current);
      current = sentence;
    }
  }
  if (current) segments.push(current);

  // 第4步:标点处理(keepPunct=false 时剔除所有标点)
  const result = opts.keepPunct
    ? segments.map((s) => s.trim())
    : segments.map((s) => s.replace(ALL_PUNCT_REGEX, '').trim());

  return result.filter((s) => s.length > 0);
}

/**
 * 字幕提取:调用 ffmpeg 从视频文件提取第一条内嵌字幕流并转为 SRT
 * 命令:ffmpeg -y -i <input> -map 0:s:0 -c:s srt <output>
 * @param filePath 视频文件路径
 * @param outputPath 输出 SRT 文件路径
 * @returns 生成的 SRT 文件路径
 */
export async function extractSubtitle(filePath: string, outputPath: string): Promise<string> {
  // 确保输出目录存在
  mkdirSync(dirname(outputPath), { recursive: true });

  try {
    // -y: 覆写输出; -map 0:s:0: 取第一条字幕流; -c:s srt: 强制输出 SRT 编码
    const { stderr } = await execFileAsync('ffmpeg', [
      '-y',
      '-i', filePath,
      '-map', '0:s:0',
      '-c:s', 'srt',
      outputPath,
    ]);
    // ffmpeg 进程信息走 stderr(非错误),截取前 500 字符用于调试
    logger.info(`[material-process] 字幕提取完成: ${outputPath}`);
    if (stderr) logger.debug(`[material-process] ffmpeg stderr: ${stderr.slice(0, 500)}`);
    return outputPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 无字幕流时给出友好提示
    if (msg.includes('Stream specifier') || msg.includes('No subtitle') || msg.includes('ENOENT')) {
      throw new Error(`文件未包含内嵌字幕流或 ffmpeg 不可用: ${filePath}`);
    }
    throw new Error(`字幕提取失败: ${msg}`);
  }
}
