/**
 * 镜头检测类型定义
 * 集中声明镜头节点、检测参数、检测结果类型。
 * 主进程服务层与 IPC 层共享这些类型,供影视解说克隆模块解析参考视频镜头边界。
 */

/**
 * 单个镜头节点
 * 表示视频中一段连续的画面区间
 */
export interface Shot {
  /** 索引(从 0 开始) */
  index: number;
  /** 起始时间(秒) */
  startTime: number;
  /** 结束时间(秒) */
  endTime: number;
  /** 时长(秒) */
  duration: number;
  /** 场景变化分数(0-1),越高越是切换点 */
  score?: number;
}

/**
 * 检测参数
 */
export interface DetectOptions {
  /** 场景变化阈值(0-1),默认 0.4,越低检测到越多镜头 */
  threshold?: number;
  /** 最小镜头时长(秒),默认 1.0,短于此的合并到上一个 */
  minDuration?: number;
}

/**
 * 检测结果
 */
export interface DetectResult {
  /** 镜头列表(已按时间排序) */
  shots: Shot[];
  /** 视频总时长(秒) */
  totalDuration: number;
  /** 镜头数量 */
  shotCount: number;
}
