/**
 * 文本即时间线类型定义(PRD-文本即时间线 v2.0 FR-1/FR-3/FR-4)
 *
 * 职责:声明句级转写段落、编辑操作(EditOp)与非破坏性 EDL 的数据结构
 * 设计要点:
 *   - EDL 采用"有序保留片段"模型:cut 从源时间轴上移除素材并把相邻保留片段切开,
 *     mute/move 是片段上的变换;导出时映射为 ffmpeg trim/concat/静音
 *   - 全部纯数据结构,不依赖 electron
 */

/** 句级转写段落(FR-1) */
export interface TextSegment {
  /** 唯一标识(seg-1 起) */
  id: string;
  /** 句子文本 */
  text: string;
  /** 起始时间(秒) */
  start: number;
  /** 结束时间(秒) */
  end: number;
  /** 说话人(可选,ASR 支持时填充) */
  speaker?: string;
  /** 词级时间戳(尽力而为,不阻塞;PRD 8 风险:词级不准以句级为准) */
  words?: WordTiming[];
}

/** 词级时间戳 */
export interface WordTiming {
  /** 词文本 */
  text: string;
  /** 起始秒 */
  start: number;
  /** 结束秒 */
  end: number;
}

/** 编辑操作(FR-4 编辑计划的最小单元) */
export type EditOp =
  | { op: 'cut'; start: number; end: number; reason?: string }
  | { op: 'mute'; start: number; end: number; reason?: string }
  | { op: 'move'; srcStart: number; srcEnd: number; dstIndex: number; reason?: string }
  | { op: 'retune'; param: string; value: string; reason?: string };

/** 保留片段(源时间轴上的一个保留区间,可整体静音) */
export interface EdlClip {
  /** 片段唯一标识(clip-1 起,应用变换后可能拆分) */
  id: string;
  /** 源素材起点(秒) */
  srcStart: number;
  /** 源素材终点(秒) */
  srcEnd: number;
  /** 是否静音(部分静音通过片段拆分表达) */
  muted?: boolean;
}

/** 非破坏性编辑决策列表(FR-3) */
export interface EDL {
  /** 源素材路径 */
  sourcePath: string;
  /** 源素材总时长(秒) */
  durationSec: number;
  /** 有序保留片段(导出 = 逐段 trim + concat) */
  clips: EdlClip[];
}
