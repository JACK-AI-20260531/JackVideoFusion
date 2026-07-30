/**
 * 镜头检测 IPC 注册
 *
 * 通道:
 *   shot-detect:detect - 检测视频镜头边界,返回 DetectResult
 *
 * 集成方式:在 electron/ipc/index.ts 的 registrars 数组追加
 *   import { register as registerShotDetect } from '../../src/main/ipc/shot-detect.ipc';
 *   并在数组中加入 registerShotDetect
 * 本文件只 export register,不修改任何既有入口。
 */
import type { ipcMain } from 'electron';
import { safeHandle } from '../../../electron/ipc';
import { shotDetectService } from '../services/shot-detect';
import type { DetectOptions } from '../services/shot-detect';

/** detect payload */
interface DetectPayload {
  /** 视频文件路径 */
  videoPath: string;
  /** 检测参数(可选) */
  opts?: DetectOptions;
}

/**
 * 注册 shot-detect:* 系列 IPC handler
 * @param ipc ipcMain 实例
 */
export function register(ipc: typeof ipcMain): void {
  /**
   * 检测视频镜头边界
   * 入参: { videoPath: string, opts?: DetectOptions }
   * 返回: DetectResult
   */
  safeHandle(ipc, 'shot-detect:detect', async (_event, payload) => {
    const p = payload as DetectPayload;
    if (!p || typeof p.videoPath !== 'string' || p.videoPath.length === 0) {
      throw new Error('缺少 videoPath 参数');
    }
    return shotDetectService.detect(p.videoPath, p.opts);
  });
}
