/**
 * 视频混剪服务统一入口
 *
 * 职责:
 *  - 提供 VideoMixService 类,根据 params.mode 分发到对应执行器
 *  - 暴露 videoMixService 单例供 IPC 层调用
 *
 * 模式说明:
 *  - random:随机素材混剪,多文件夹各抽 N 条 → 切短 → 拼接 → 后处理
 *  - audio-match:文件夹音频匹配,每文件夹独立合成(音频+视频)→ 拼接 → 后处理
 */
import { CancelToken } from '../ffmpeg/types';
import type { MixParams, MixResult } from './types';
import { runRandomMix } from './random-mixer';
import { runAudioMatch } from './audio-matcher';

/**
 * 视频混剪服务类
 * 通过 runMix 方法分发到 random / audio-match 两种执行器
 */
export class VideoMixService {
  /**
   * 执行混剪(根据 params.mode 分发)
   * @param params 混剪参数
   * @param taskId 任务 ID(用于进度推送与 checkpoint)
   * @param token 取消令牌
   * @returns 混剪结果(输出路径、时长、片段数)
   */
  async runMix(
    params: MixParams,
    taskId: string,
    token: CancelToken,
  ): Promise<MixResult> {
    if (params.mode === 'random') {
      return runRandomMix(params, taskId, token);
    }
    return runAudioMatch(params, taskId, token);
  }
}

/**
 * 视频混剪服务单例
 * IPC 层调用此单例的 runMix 方法执行混剪任务
 */
export const videoMixService = new VideoMixService();

// 重新导出类型与子模块,便于外部统一引用
export type { MixMode, MixParams, MixResult } from './types';
export { runRandomMix } from './random-mixer';
export { runAudioMatch } from './audio-matcher';
