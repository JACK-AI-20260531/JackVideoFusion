/**
 * 多行拼接纯函数
 * 职责:把路径数组拼接为多行文本(每行一个,过滤空项,去重保留首次出现顺序)
 */

/**
 * 将路径数组拼接为多行文本
 * @param paths 路径数组
 * @returns 每行一个的非空路径文本;空数组返回空字符串
 */
export function joinLines(paths: unknown[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim().length === 0) {
      continue;
    }
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    lines.push(p);
  }
  return lines.join('\n');
}
