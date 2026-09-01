/**
 * 账号健康度评估(PRD-v1.7 数据飞轮与全景矩阵 FR-8)
 *
 * 职责:按平台登录状态与最近活跃时间评估是否需要关注,纯函数可单测
 * 规则:
 *   - expired → 需要注意(重新扫码)
 *   - logged-out → 不预警(用户从未登录)
 *   - logged-in 且最近活跃时间距今超过阈值(默认 3 天) → 建议发布前先检测登录
 */
import type { AccountInfo, LoginStatus, PublishPlatform } from './types';

/** 登录态验证提醒阈值:3 天(毫秒) */
export const LOGIN_CHECK_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** 单平台账号健康度 */
export interface AccountHealth {
  /** 平台标识 */
  platform: PublishPlatform;
  /** 登录状态 */
  loginStatus: LoginStatus;
  /** 最近活跃时间(ISO,可空) */
  lastActiveAt?: string;
  /** 是否需要注意 */
  needsAttention: boolean;
  /** 注意原因 */
  reason?: string;
}

/**
 * 评估账号健康度(纯函数)
 * @param accounts 账号信息列表
 * @param now 当前时间戳(毫秒)
 * @param thresholdMs 登录态验证阈值(默认 3 天)
 * @returns 各平台健康度列表
 */
export function assessAccountHealth(
  accounts: AccountInfo[],
  now: number = Date.now(),
  thresholdMs: number = LOGIN_CHECK_THRESHOLD_MS,
): AccountHealth[] {
  return accounts.map((a) => {
    if (a.loginStatus === 'expired') {
      return { ...a, needsAttention: true, reason: '登录已过期,请重新扫码登录' };
    }
    if (a.loginStatus === 'logged-out') {
      return { ...a, needsAttention: false };
    }
    const last = a.lastActiveAt ? Date.parse(a.lastActiveAt) : NaN;
    if (Number.isFinite(last) && now - last > thresholdMs) {
      return {
        ...a,
        needsAttention: true,
        reason: '登录态较旧,批量发布前建议先「检测登录」',
      };
    }
    return { ...a, needsAttention: false };
  });
}
