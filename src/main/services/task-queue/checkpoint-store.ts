/**
 * 检查点持久化存储
 * 职责:将每个任务的最新 checkpoint 持久化到磁盘,支持断点续渲染
 *
 * 实现说明:
 *  - 任务约定使用 electron-store,但 electron-store@10 为 ESM-only
 *    与当前 tsconfig.electron.json 的 CommonJS 编译目标运行时不兼容
 *    (require('electron-store') 会抛 ERR_REQUIRE_ESM)
 *  - 本模块改用 Node 原生 fs 同步 API 实现 JSON 持久化,语义等价、
 *    无外部依赖风险,且满足同步 API 契约
 *  - 存储位置:userData/task-checkpoints/{taskId}.json(每个任务覆盖式保留最新)
 */
import { app } from 'electron';
import { join } from 'path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import type { Checkpoint } from './types';

/**
 * 获取 checkpoint 存储目录
 * 位于 userData/task-checkpoints/
 */
function checkpointsDir(): string {
  return join(app.getPath('userData'), 'task-checkpoints');
}

/**
 * 确保存储目录存在(幂等)
 */
function ensureDir(): void {
  mkdirSync(checkpointsDir(), { recursive: true });
}

/**
 * 获取指定任务的 checkpoint 文件路径
 */
function filePath(taskId: string): string {
  return join(checkpointsDir(), `${taskId}.json`);
}

/**
 * 保存检查点(覆盖式,每个任务只保留最新)
 * @param taskId   任务 ID
 * @param step     当前原子步骤名
 * @param progress 步骤进度 0-100
 * @param ctx      步骤上下文(下游任务输入)
 */
export function saveCheckpoint(
  taskId: string,
  step: string,
  progress: number,
  ctx: unknown,
): void {
  ensureDir();
  const checkpoint: Checkpoint = {
    taskId,
    step,
    progress,
    context: ctx,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(filePath(taskId), JSON.stringify(checkpoint, null, 2), 'utf8');
}

/**
 * 加载检查点
 * @param taskId 任务 ID
 * @returns 检查点对象,不存在或解析失败时返回 null
 */
export function loadCheckpoint(taskId: string): Checkpoint | null {
  const fp = filePath(taskId);
  if (!existsSync(fp)) return null;
  try {
    const raw = readFileSync(fp, 'utf8');
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * 删除检查点(任务完成/失败/取消后清理)
 */
export function removeCheckpoint(taskId: string): void {
  const fp = filePath(taskId);
  if (existsSync(fp)) {
    try {
      unlinkSync(fp);
    } catch {
      // 忽略删除失败(文件可能已被移除)
    }
  }
}

/**
 * 列出所有存在检查点的任务 ID
 * 用于诊断或批量恢复
 */
export function listCheckpointTaskIds(): string[] {
  ensureDir();
  return readdirSync(checkpointsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
