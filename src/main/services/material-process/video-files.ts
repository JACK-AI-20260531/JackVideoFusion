/**
 * 视频文件过滤纯函数
 * 职责:判断文件名是否为常见视频扩展名,并从列表中过滤出视频文件
 */

/** 常见视频扩展名(小写) */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm']);

/**
 * 判断文件名是否为常见视频文件(扩展名大小写不敏感)
 * @param fileName 文件名
 * @returns 是否为视频文件
 */
export function isVideoFile(fileName: string): boolean {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) {
    return false;
  }
  const ext = fileName.slice(idx + 1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * 从文件名列表中过滤出视频文件
 * @param files 文件名字符串数组
 * @returns 视频文件数组
 */
export function filterVideoFiles(files: string[]): string[] {
  return files.filter(isVideoFile);
}
