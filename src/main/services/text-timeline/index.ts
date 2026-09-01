/**
 * 文本即时间线服务统一入口(PRD-文本即时间线 v2.0)
 * 职责:导出转写/EDL/命令栈纯函数,供 IPC 层与渲染层引用
 */
export type { TextSegment, WordTiming, EditOp, EDL, EdlClip } from './types';
export {
  parseSrtToSegments,
  parseTimestamp,
  planFillerCuts,
  planPauseCompression,
  CUT_MARGIN_SEC,
  PAUSE_THRESHOLD_SEC,
  DEFAULT_FILLER_WORDS,
} from './transcript';
export {
  createEdl,
  applyCut,
  applyMute,
  applyMove,
  applyOps,
  totalDuration,
  isValidRange,
  clampRange,
} from './edl';
export { CommandStack } from './command-stack';
