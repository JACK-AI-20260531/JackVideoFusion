/**
 * 素材处理服务
 * 职责:文本分割(纯 Node 字符串处理,实现在 text-split.ts)、字幕提取(调用 ffmpeg -map 0:s:0)
 * 依赖:child_process(execFile) 调用系统 ffmpeg;logger 记录日志
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../../utils/logger';
import { filterVideoFiles } from './video-files';

// 重新导出文本分割纯函数(实现抽离到 text-split.ts,便于独立单元测试)
export { splitText } from './text-split';

// promisify execFile,获得 Promise 风格的异步执行
const execFileAsync = promisify(execFile);

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

/**
 * 列出目录下的视频文件(仅一层,不递归),供“导入文件夹”使用
 * @param dirPath 目录路径
 * @returns 目录下视频文件的绝对路径数组,目录不存在或不可读时返回空数组
 */
export function listVideoFiles(dirPath: string): string[] {
  if (!dirPath) {
    return [];
  }
  try {
    const names = readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    return filterVideoFiles(names).map((name) => join(dirPath, name));
  } catch (err) {
    logger.warn(`[material-process] 读取目录失败: ${dirPath}`, err);
    return [];
  }
}
