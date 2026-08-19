/**
 * 产物清单导出工具
 * 职责:批量产物路径清单构建、复制与 TXT 下载
 */
import { shouldCopy } from './clipboard';
import { joinLines } from './join-lines';

/**
 * 构建批量产物路径清单文本
 * @param paths 产物路径列表
 * @returns 每行一个产物路径的清单文本
 */
export function buildManifestText(paths: unknown[]): string {
  return joinLines(paths);
}

/**
 * 生成产物清单文件名
 * @param scope 业务场景前缀
 * @param timestamp 时间戳
 * @returns txt 清单文件名
 */
export function createManifestFilename(scope: string, timestamp = Date.now()): string {
  return `${scope}-manifest-${timestamp}.txt`;
}

/**
 * 复制产物路径清单到剪贴板
 * @param paths 产物路径列表
 * @returns 是否成功触发复制
 */
export async function copyManifestPaths(paths: unknown[]): Promise<boolean> {
  return shouldCopy(buildManifestText(paths));
}

/**
 * 下载产物路径清单 TXT 文件
 * @param paths 产物路径列表
 * @param filename 下载文件名
 * @returns 是否成功触发下载
 */
export function downloadManifest(paths: unknown[], filename: string): boolean {
  const text = buildManifestText(paths);
  if (text.trim().length === 0) {
    return false;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
