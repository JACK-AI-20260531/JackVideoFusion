/**
 * 任务队列本地类型定义
 * 职责:定义任务条目、事件、检查点、队列接口等本地类型
 *       与渲染层 TaskItem 结构保持一致,主进程独立定义以避免依赖 vue/pinia
 */
import type { TaskStatus, TaskType } from '../../../shared/types';

/**
 * 任务条目结构
 * 与 src/renderer/stores/task.ts 中的 TaskItem 结构一致
 */
export interface TaskItem {
  // 任务唯一标识
  id: string;
  // 任务类型(对应各功能模块)
  type: TaskType;
  // 任务标题(UI 展示用)
  title: string;
  // 当前任务状态
  status: TaskStatus;
  // 进度百分比 0-100
  progress: number;
  // 任务参数(各功能模块自定义)
  params: Record<string, unknown>;
  // 任务输出路径(完成后填充)
  output?: string;
  // 失败原因
  error?: string;
  // 创建时间(ISO 字符串)
  createdAt: string;
  // 开始执行时间
  startedAt?: string;
  // 结束时间(完成/失败/取消时填充)
  finishedAt?: string;
}

/**
 * 任务事件枚举(驱动状态机转换)
 * start:    开始执行 pending→running
 * pause:    暂停 running→paused
 * resume:   恢复 paused→running
 * complete: 完成 running→completed
 * fail:     失败 running→failed
 * cancel:   取消(多源 → cancelled)
 */
export type TaskEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'fail'
  | 'cancel';

/**
 * 断点续渲染检查点
 * 每个原子步骤落一次 checkpoint,崩溃后可从最近 checkpoint 恢复
 */
export interface Checkpoint {
  // 所属任务 ID
  taskId: string;
  // 当前原子步骤名(如 'ffmpeg-split', 'tts-synthesize')
  step: string;
  // 步骤进度 0-100
  progress: number;
  // 步骤上下文(下游任务输入,如分段文件列表)
  context: unknown;
  // 保存时间(ISO 字符串)
  savedAt: string;
}

/**
 * 任务队列接口
 * 契约方法(enqueue/pause/resume/cancel/list/get/saveCheckpoint/loadCheckpoint)
 * 扩展方法(complete/fail/updateProgress/setConcurrency/restoreOnStartup)供执行者与启动恢复使用
 */
export interface TaskQueue {
  /** 入队任务,返回任务 ID */
  enqueue(task: TaskItem): string;
  /** 暂停任务 */
  pause(taskId: string): void;
  /** 恢复任务 */
  resume(taskId: string): void;
  /** 取消任务 */
  cancel(taskId: string): void;
  /** 列出所有任务(按创建时间升序) */
  list(): TaskItem[];
  /** 获取单个任务,不存在返回 null */
  get(taskId: string): TaskItem | null;
  /** 保存检查点(同步) */
  saveCheckpoint(taskId: string, step: string, progress: number, ctx: unknown): void;
  /** 加载检查点,不存在返回 null */
  loadCheckpoint(taskId: string): Checkpoint | null;
  /** 标记任务完成(执行者调用) */
  complete(taskId: string, output?: string): void;
  /** 标记任务失败(执行者调用) */
  fail(taskId: string, error: string): void;
  /** 更新任务进度(执行者调用) */
  updateProgress(taskId: string, progress: number): void;
  /** 设置最大并发数 */
  setConcurrency(n: number): void;
  /** 启动恢复:将所有 running 任务转为 paused(进程崩溃兜底) */
  restoreOnStartup(): void;
}
