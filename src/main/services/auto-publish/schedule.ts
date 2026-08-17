/**
 * 定时发布调度纯函数
 * 职责:计算 scheduledAt 到点执行的延迟毫秒数
 *      纯函数,不依赖 electron/task-queue,可独立单元测试
 */

/**
 * 计算定时发布的延迟毫秒数
 * @param scheduledAt 定时发布时间(ISO);为空或已过去则返回 null(视为立即执行)
 * @returns 距到点的毫秒数;不可定时时返回 null
 */
export function computeScheduleDelayMs(scheduledAt?: string): number | null {
  if (!scheduledAt || scheduledAt.trim().length === 0) return null;
  const target = new Date(scheduledAt).getTime();
  if (isNaN(target)) return null;
  const delay = target - Date.now();
  return delay > 0 ? delay : null;
}
