/**
 * 任务队列模块统一出口
 * 职责:集中导出状态机、队列单例、检查点存储与类型,供主进程其他模块消费
 */
export { transition, isTerminal } from './state-machine';
export { taskQueue } from './task-queue';
export {
  saveCheckpoint,
  loadCheckpoint,
  removeCheckpoint,
  listCheckpointTaskIds,
} from './checkpoint-store';
export type {
  TaskItem,
  TaskEvent,
  Checkpoint,
  TaskQueue,
} from './types';
