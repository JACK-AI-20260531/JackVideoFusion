/**
 * shell 路径提取纯函数
 * 职责:从 IPC 载荷中安全提取要打开/定位的文件路径
 */

/**
 * 提取目标路径,非法或缺失时返回空字符串(供 shell handler 校验)
 * @param payload IPC 载荷(可为 { path } 对象或裸字符串)
 * @returns 非空路径字符串;否则返回空字符串
 */
export function extractPath(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload.trim();
  }
  if (payload && typeof payload === 'object') {
    const path = (payload as { path?: unknown }).path;
    return typeof path === 'string' ? path.trim() : '';
  }
  return '';
}
