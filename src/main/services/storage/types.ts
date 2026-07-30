/**
 * 任务队列存储接口与数据类型
 * 职责:定义任务持久化的接口契约,供 Task 005(任务调度)调用
 *       底层可替换为不同实现(electron-store / SQLite 等),只需实现 ITaskStore
 */
import type { TaskStatus, TaskType } from '../../../shared/types';

/**
 * 任务记录(持久化到本地的一条任务)
 */
export interface TaskRecord {
  /** 任务唯一 ID */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务输入参数(各任务类型自定义) */
  payload: Record<string, unknown>;
  /** 任务输出结果(完成后填充) */
  result?: Record<string, unknown>;
  /** 失败原因(失败时填充) */
  error?: string;
  /** 进度百分比 0-100 */
  progress?: number;
  /** 创建时间(ISO 8601) */
  createdAt: string;
  /** 最后更新时间(ISO 8601) */
  updatedAt: string;
  /** 开始执行时间(ISO 8601) */
  startedAt?: string;
  /** 完成时间(ISO 8601) */
  finishedAt?: string;
}

/**
 * 任务列表过滤条件
 */
export interface TaskListFilter {
  /** 按状态过滤 */
  status?: TaskStatus;
  /** 按类型过滤 */
  type?: TaskType;
}

/**
 * 任务存储接口契约
 * 所有方法均为异步,兼容异步存储后端
 */
export interface ITaskStore {
  /**
   * 保存(或覆盖)一条任务记录
   * @param task 任务记录
   */
  saveTask(task: TaskRecord): Promise<void>;
  /**
   * 增量更新任务记录
   * @param id 任务 ID
   * @param patch 待更新的字段
   * @returns 更新后的完整记录;若 id 不存在返回 null
   */
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null>;
  /**
   * 获取单条任务记录
   * @param id 任务 ID
   * @returns 任务记录;不存在返回 null
   */
  getTask(id: string): Promise<TaskRecord | null>;
  /**
   * 列出任务记录(支持过滤)
   * @param filter 过滤条件
   * @returns 任务记录数组(按创建时间升序)
   */
  listTasks(filter?: TaskListFilter): Promise<TaskRecord[]>;
  /**
   * 删除一条任务记录
   * @param id 任务 ID
   * @returns 是否删除成功
   */
  deleteTask(id: string): Promise<boolean>;
  /**
   * 清空所有任务记录
   */
  clearAll(): Promise<void>;
}
