/**
 * 时长格式化纯函数
 * 职责:把秒数格式化为可读时长字符串(mm:ss 或 h:mm:ss)
 */

/**
 * 将秒数格式化为时长
 * @param sec 秒数(可为小数/负数/NaN)
 * @returns 形如 "0:05" / "1:30" / "1:01:01" 的字符串;非法值归零
 */
export function formatDurationSec(sec: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}
