/**
 * 流水线校验纯函数(PRD-v2.1 FR-2)
 * 职责:校验 schedule 与 steps(逐字段校验,返回首个错误信息,不抛错)
 * 设计要点:不依赖 electron,可 node:test 单测;错误信息中文,直接面向用户
 */
import type {
  AutoPublishStepParams,
  MaterialSplitStepParams,
  PipelineSchedule,
  PipelineStep,
  VideoMixStepParams,
} from './types';

/** 平台枚举(与 auto-publish adapters 一致) */
const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'shipinhao', 'spzx'];

/**
 * 校验定时配置;undefined=不定时,合法
 * @returns 错误信息;合法返回 null
 */
export function validateSchedule(s: PipelineSchedule | undefined): string | null {
  if (!s) return null;
  if (s.kind !== 'daily' && s.kind !== 'weekly' && s.kind !== 'once') return 'schedule.kind 非法';
  if (!/^\d{2}:\d{2}$/.test(s.at)) return 'schedule.at 需为 HH:mm';
  const [hh, mm] = s.at.split(':').map(Number);
  if (hh > 23 || mm > 59) return 'schedule.at 时间越界';
  if (s.kind === 'weekly' && (s.weekday === undefined || s.weekday < 0 || s.weekday > 6)) {
    return 'weekly 需要合法 weekday(0-6)';
  }
  return null;
}

/**
 * 校验步骤数组(逐字段);全部合法返回 null
 */
export function validateSteps(steps: PipelineStep[]): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return 'steps 不能为空';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const tag = `steps[${i}]`;
    if (step.type === 'material-split') {
      const p = step.params as unknown as MaterialSplitStepParams;
      if (!Array.isArray(p.files) || p.files.length === 0) return `${tag}:files 不能为空`;
      if (!(p.segmentSec > 0)) return `${tag}:segmentSec 必须 > 0`;
      if (!p.outputDir) return `${tag}:outputDir 不能为空`;
    } else if (step.type === 'video-mix-random') {
      const p = (step.params as unknown as VideoMixStepParams).params;
      if (!p || (p.mode !== 'random' && p.mode !== 'audio-match')) return `${tag}:mode 非法`;
      if (!Array.isArray(p.folderIds) || p.folderIds.length === 0) return `${tag}:folderIds 不能为空`;
    } else if (step.type === 'auto-publish') {
      const p = (step.params as unknown as AutoPublishStepParams).params;
      if (!p) return `${tag}:params 缺失`;
      if (!PLATFORMS.includes(p.platform)) return `${tag}:platform 非法`;
      if (!p.title) return `${tag}:title 不能为空`;
      // videoPath 允许为空:可自动接上一步产物
    } else {
      return `${tag}:type 非法(${step.type})`;
    }
  }
  return null;
}
