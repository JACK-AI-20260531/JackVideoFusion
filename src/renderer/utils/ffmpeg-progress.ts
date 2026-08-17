/**
 * FFmpeg 进度解析纯函数
 * 职责:从 ffmpeg:progress 推送载荷中解析出 taskId 与 percent
 */

export interface FfmpegProgressInfo {
  taskId: string;
  percent: number;
}

/**
 * 从 ffmpeg:progress 事件载荷中解析进度信息
 * @param payload 事件载荷
 * @returns 解析结果,载荷非法或字段缺失时返回 null
 */
export function parseFfmpegProgress(payload: unknown): FfmpegProgressInfo | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const p = payload as { taskId?: unknown; percent?: unknown };
  if (typeof p.taskId !== 'string' || p.taskId.length === 0) {
    return null;
  }
  if (typeof p.percent !== 'number' || Number.isNaN(p.percent)) {
    return null;
  }
  return { taskId: p.taskId, percent: p.percent };
}
