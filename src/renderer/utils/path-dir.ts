/**
 * 目录提取纯函数
 * 职责:从产出文件路径中提取所在目录(兼容 \ 与 / 分隔符)
 */

/**
 * 提取文件路径所在目录
 * @param filePath 文件绝对路径
 * @returns 目录字符串;无目录信息或非法输入时返回空字符串
 */
export function resolveDirOf(filePath: unknown): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return '';
  }
  // 统一按最后一个分隔符截断(兼容 Windows 的 \ 与 POSIX 的 /)
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx <= 0) {
    return '';
  }
  return filePath.slice(0, idx);
}
