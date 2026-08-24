/**
 * GPT-SoVITS 服务管理
 *
 * 职责:管理 GPT-SoVITS api_v2 Python 子进程的生命周期,包括:
 *   - checkInstalled():检测本机 python 与 api_v2.py 是否可用
 *   - getStatus():获取当前服务状态(GptSoVitsStatus)
 *   - start(config):spawn python api_v2.py,轮询健康检查后置为 running
 *   - stop():终止子进程并清理资源
 *
 * 实现说明:
 *   - 使用 child_process.spawn 启动 GPT-SoVITS server
 *   - 通过 stdout/stderr 收集日志,转发到 winston logger
 *   - 通过 gptSoVitsClient.checkHealth 轮询服务就绪
 *   - 进程退出时自动更新状态,避免悬挂
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import { logger } from '../../utils/logger';
import { gptSoVitsClient } from './gpt-sovits-client';
import type { GptSoVitsConfig, GptSoVitsStatus } from './types';

const execAsync = promisify(exec);

/** 启动后健康检查轮询间隔(毫秒) */
const HEALTH_POLL_INTERVAL_MS = 1_000;

/** 启动后健康检查最大等待时间(毫秒,30 秒) */
const HEALTH_POLL_TIMEOUT_MS = 30_000;

/** Python 候选可执行名(Windows 优先 python,兼容 py launcher) */
const PYTHON_CANDIDATES = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

/** api_v2.py 相对路径(GPT-SoVITS 仓库根目录下) */
const API_V2_RELATIVE = 'api_v2.py';

/** 服务状态单例(模块级共享) */
let currentStatus: GptSoVitsStatus = 'not-installed';

/** 当前子进程引用 */
let currentProcess: ChildProcess | null = null;

/** 当前配置(供 stop 后重新检查使用) */
let currentConfig: GptSoVitsConfig | null = null;

/** 检测到的 Python 可执行文件路径缓存 */
let pythonExeCache: string | null | undefined;

/**
 * 在 PATH 中查找命令路径
 * Windows 使用 where,其它平台使用 which
 * @param cmd 命令名,如 python
 * @returns 命令绝对路径,未找到返回 null
 */
async function which(cmd: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execAsync(`${finder} ${cmd}`);
    const first = stdout.split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * 查找 Python 可执行文件
 * 依次尝试 PYTHON_CANDIDATES,返回首个可用的路径
 * @returns Python 路径,未找到返回 null
 */
async function findPython(): Promise<string | null> {
  if (pythonExeCache !== undefined) return pythonExeCache;
  for (const candidate of PYTHON_CANDIDATES) {
    const path = await which(candidate);
    if (path) {
      pythonExeCache = path;
      logger.info(`[voice-clone/manager] 检测到 Python: ${path}`);
      return path;
    }
  }
  pythonExeCache = null;
  logger.warn('[voice-clone/manager] 未检测到 Python 可执行文件');
  return null;
}

/**
 * 构造 GPT-SoVITS api_v2.py 的启动参数
 * @param config 服务配置
 * @param pythonExe Python 可执行文件路径
 * @returns 启动参数数组(第一项为可执行文件路径)
 */
export function buildSpawnArgs(config: GptSoVitsConfig, pythonExe: string): string[] {
  const apiScript = join(config.installPath, API_V2_RELATIVE);
  const args = [apiScript, '-p', String(config.port), '-a', '127.0.0.1'];
  if (config.modelPath) {
    args.push('-g', config.modelPath);
  }
  if (config.sovitsModelPath) {
    args.push('-s', config.sovitsModelPath);
  }
  return [pythonExe, ...args];
}

/**
 * 轮询健康检查直到服务就绪或超时
 * @param port 监听端口
 * @returns 是否就绪
 */
async function pollHealthUntilReady(port: number): Promise<boolean> {
  gptSoVitsClient.setBaseUrl('127.0.0.1', port);
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ok = await gptSoVitsClient.checkHealth(3_000);
    if (ok) return true;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * 等待指定毫秒数
 * @param ms 毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GPT-SoVITS 服务管理类
 */
export class ServiceManager {
  /**
   * 检查 GPT-SoVITS 是否已安装
   * 判定条件:Python 可用 且 installPath/api_v2.py 文件存在
   * @param installPath 可选安装路径,未提供时仅检测 Python
   * @returns 是否已安装
   */
  async checkInstalled(installPath?: string): Promise<boolean> {
    const pythonOk = (await findPython()) !== null;
    if (!pythonOk) {
      currentStatus = 'not-installed';
      return false;
    }
    if (installPath) {
      const apiScript = join(installPath, API_V2_RELATIVE);
      if (!existsSync(apiScript)) {
        logger.warn(`[voice-clone/manager] api_v2.py 不存在: ${apiScript}`);
        currentStatus = 'not-installed';
        return false;
      }
    }
    // 已检测到 Python,即便未指定 installPath 也视为可启动(可能在 PATH 下)
    if (currentStatus === 'not-installed') {
      currentStatus = 'stopped';
    }
    return true;
  }

  /**
   * 获取当前服务状态
   * @returns 服务状态
   */
  getStatus(): GptSoVitsStatus {
    return currentStatus;
  }

  /**
   * 启动 GPT-SoVITS server
   * 1. 校验 Python 与 api_v2.py
   * 2. spawn 子进程
   * 3. 轮询健康检查直到就绪
   * @param config 服务配置
   * @returns 是否启动成功
   */
  async start(config: GptSoVitsConfig): Promise<boolean> {
    // 已在运行直接返回成功
    if (currentStatus === 'running') {
      logger.info('[voice-clone/manager] 服务已在运行,跳过启动');
      return true;
    }

    // 强制校验 Python 与 api_v2.py
    const installed = await this.checkInstalled(config.installPath);
    if (!installed) {
      throw new Error(
        `GPT-SoVITS 未安装:请确认 Python 可用且 ${config.installPath}/${API_V2_RELATIVE} 存在`,
      );
    }

    const pythonExe = (await findPython()) as string;
    const spawnArgs = buildSpawnArgs(config, pythonExe);
    logger.info(
      `[voice-clone/manager] 启动 GPT-SoVITS: ${spawnArgs.join(' ')}`,
    );

    currentStatus = 'starting';
    currentConfig = config;

    // spawn 子进程
    const child = spawn(spawnArgs[0], spawnArgs.slice(1), {
      cwd: config.installPath,
      windowsHide: true,
      env: { ...process.env },
    });
    currentProcess = child;

    // 转发 stdout 日志
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        logger.info(`[voice-clone/manager/gpt-sovits] ${text}`);
      }
    });

    // 转发 stderr 日志
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        logger.warn(`[voice-clone/manager/gpt-sovits] ${text}`);
      }
    });

    // 进程异常退出处理
    child.on('error', (err: Error) => {
      logger.error(`[voice-clone/manager] 子进程错误: ${err.message}`);
      currentStatus = 'error';
      currentProcess = null;
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      logger.info(
        `[voice-clone/manager] 子进程退出 code=${code} signal=${signal ?? 'null'}`,
      );
      if (currentStatus !== 'stopped') {
        // 非主动停止的退出视为错误
        currentStatus = currentStatus === 'starting' ? 'error' : 'stopped';
      }
      currentProcess = null;
    });

    // 轮询健康检查
    const ready = await pollHealthUntilReady(config.port);
    if (ready) {
      currentStatus = 'running';
      logger.info('[voice-clone/manager] GPT-SoVITS 服务已就绪');
      return true;
    }

    // 健康检查超时,杀进程后置为错误
    logger.error('[voice-clone/manager] GPT-SoVITS 启动超时,健康检查未通过');
    await this.killChild();
    currentStatus = 'error';
    return false;
  }

  /**
   * 停止 GPT-SoVITS 服务
   * 终止子进程并重置状态
   * @returns 是否成功停止
   */
  async stop(): Promise<boolean> {
    currentStatus = 'stopped';
    await this.killChild();
    currentConfig = null;
    logger.info('[voice-clone/manager] GPT-SoVITS 服务已停止');
    return true;
  }

  /**
   * 终止子进程(同步清理引用)
   * 优先 SIGTERM,Windows 下使用 taskkill /T /F 强制结束进程树
   */
  private async killChild(): Promise<void> {
    if (!currentProcess) return;
    const child = currentProcess;
    currentProcess = null;
    try {
      if (process.platform === 'win32') {
        // Windows 上 SIGTERM 不一定生效,用 taskkill 强制结束进程树
        await promisify(exec)(`taskkill /PID ${child.pid} /T /F`).catch(() => null);
      } else {
        child.kill('SIGTERM');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[voice-clone/manager] 终止子进程失败: ${msg}`);
    }
  }
}

/** 服务管理单例(全局复用) */
export const serviceManager = new ServiceManager();
