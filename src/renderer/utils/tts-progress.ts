/**
 * TTS 进度解析纯函数
 * 职责:从 tts:progress 推送载荷(current/total)解析出 0-100 的百分比进度
 */

/**
 * 解析 TTS 进度百分比
 * @param payload tts:progress 事件载荷
 * @returns 0-100 的整数百分比;载荷非法或缺失字段时返回 null
 */
export function parseTtsProgress(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const p = payload as { current?: unknown; total?: unknown };
  if (
    typeof p.current !== 'number' ||
    typeof p.total !== 'number' ||
    Number.isNaN(p.current) ||
    Number.isNaN(p.total) ||
    p.total <= 0
  ) {
    return null;
  }
  const percent = Math.round((p.current / p.total) * 100);
  return Math.min(100, Math.max(0, percent));
}
