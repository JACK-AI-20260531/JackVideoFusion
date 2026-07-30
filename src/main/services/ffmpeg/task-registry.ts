/**
 * FFmpeg 任务注册中心
 * 维护活跃 ffmpeg 命令的取消器,支持通过 token id 中断正在运行的子进程。
 * 用 Map<tokenId, canceler> 索引,长任务启动时注册,结束/出错时注销。
 */
import { logger } from '@main/utils/logger';

/**
 * 取消器函数:执行后会标记 token 并 kill 子进程
 */
type Canceler = () => void;

class FFmpegTaskRegistry {
  /** token id -> 取消器 */
  private readonly cancelers = new Map<string, Canceler>();

  /**
   * 注册一个可取消任务
   * @param tokenId 令牌 ID(同时作为任务 ID)
   * @param canceler 取消器(标记 token + kill 子进程)
   */
  register(tokenId: string, canceler: Canceler): void {
    this.cancelers.set(tokenId, canceler);
  }

  /**
   * 注销任务(任务正常结束或出错时调用)
   * @param tokenId 令牌 ID
   */
  unregister(tokenId: string): void {
    this.cancelers.delete(tokenId);
  }

  /**
   * 取消指定任务
   * @param tokenId 令牌 ID
   * @returns 是否找到并触发了取消器
   */
  cancel(tokenId: string): boolean {
    const canceler = this.cancelers.get(tokenId);
    if (!canceler) {
      logger.warn(`[FFmpeg] 未找到任务 ${tokenId},可能已结束`);
      return false;
    }
    try {
      canceler();
    } catch (err) {
      logger.error(
        `[FFmpeg] 取消任务 ${tokenId} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.cancelers.delete(tokenId);
    return true;
  }
}

/** 全局任务注册中心单例 */
export const taskRegistry = new FFmpegTaskRegistry();
