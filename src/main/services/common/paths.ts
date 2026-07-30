/**
 * 导出路径服务
 * 职责:提供默认导出目录与导出路径解析
 */
import { app } from 'electron';
import { join } from 'path';

/**
 * 获取默认导出目录:userData/exports
 * 防御性处理:app 未就绪时回退到 cwd
 * @returns 默认导出目录绝对路径
 */
export function getDefaultExportDir(): string {
  const userData = app?.getPath?.('userData') ?? process.cwd();
  return join(userData, 'exports');
}

/**
 * 解析导出路径(自定义目录优先,否则使用默认)
 * @param customDir 用户自定义导出目录(可为空字符串)
 * @param filename 输出文件名
 * @returns 完整导出文件路径
 */
export function resolveExportPath(customDir: string | undefined, filename: string): string {
  const dir = customDir && customDir.trim().length > 0 ? customDir : getDefaultExportDir();
  return join(dir, filename);
}
