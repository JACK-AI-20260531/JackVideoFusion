/**
 * 诊断包导出(PRD-v1.7 数据飞轮与全景矩阵 FR-8)
 *
 * 职责:
 *   - 收集系统信息 + 全局配置(脱敏) + 最近日志文件,打包为 zip
 *   - 供打包版问题排查(用户一键导出发给开发者)
 *
 * 设计要点:
 *   - sanitizeConfig 为纯函数:递归脱敏 key 匹配 /key|token|secret|password/i 的字段
 *   - 打包用 Windows 自带 Compress-Archive(项目仅发 Windows,无新增依赖)
 */
import { app } from 'electron';
import { join } from 'path';
import { release } from 'os';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
} from 'fs';
import { spawn } from 'child_process';
import { getConfigService } from '../config-service';
import { logger } from '../../utils/logger';

/** 诊断包内包含的日志文件数上限(按修改时间取最新) */
export const DIAG_LOG_FILE_LIMIT = 7;

/** 脱敏字段名匹配(不区分大小写) */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password/i;

/**
 * 递归脱敏配置(纯函数)
 * 键名匹配 /key|token|secret|password/i 的字符串值替换为 '***'
 * @param config 任意配置对象
 * @returns 深拷贝后的脱敏对象
 */
export function sanitizeConfig<T>(config: T): T {
  if (Array.isArray(config)) {
    return config.map((v) => sanitizeConfig(v)) as unknown as T;
  }
  if (config && typeof config === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      const sensitive = SENSITIVE_KEY_PATTERN.test(k) && (typeof v === 'string' || typeof v === 'number');
      out[k] = sensitive ? '***' : sanitizeConfig(v);
    }
    return out as unknown as T;
  }
  return config;
}

/**
 * 构造系统信息文本
 * @returns 多行系统信息
 */
export function buildSystemInfo(info: {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  osType: string;
  osRelease: string;
  userDataDir: string;
  generatedAt: string;
}): string {
  return [
    `应用版本: ${info.appVersion}`,
    `Electron: ${info.electronVersion}`,
    `Node: ${info.nodeVersion}`,
    `系统: ${info.osType} ${info.osRelease}`,
    `userData: ${info.userDataDir}`,
    `生成时间: ${info.generatedAt}`,
  ].join('\n');
}

/** exportDiagnostics 依赖注入 */
export interface DiagnosticsDeps {
  /** 日志目录(默认 userData/logs) */
  logsDir?: string;
  /** 目标输出目录(默认 userData/diagnostics) */
  outputDir?: string;
  /** 是否执行 zip 打包(测试可关闭) */
  zip?: boolean;
}

/**
 * 导出诊断包
 * 流程:暂存目录(日志 + 脱敏配置 + 系统信息)→ Compress-Archive 打包 → 清理暂存
 * @param deps 可选依赖(zip=false 时只生成暂存目录,便于测试)
 * @returns zip 文件路径(zip=false 时返回暂存目录)
 */
export async function exportDiagnostics(deps: DiagnosticsDeps = {}): Promise<string> {
  const userData = app.getPath('userData');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = join(userData, `diag-staging-${stamp}`);
  mkdirSync(staging, { recursive: true });

  try {
    // 1. 复制最近日志(按修改时间取最新 N 个)
    const logsDir = deps.logsDir ?? join(userData, 'logs');
    if (existsSync(logsDir)) {
      const files = readdirSync(logsDir)
        .map((f) => {
          const fp = join(logsDir, f);
          try {
            return { f, mtime: statSync(fp).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { f: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, DIAG_LOG_FILE_LIMIT);
      for (const { f } of files) {
        copyFileSync(join(logsDir, f), join(staging, f));
      }
    }

    // 2. 脱敏配置
    try {
      const config = await getConfigService().getConfig();
      writeFileSync(join(staging, 'config.json'), JSON.stringify(sanitizeConfig(config), null, 2), 'utf8');
    } catch (err) {
      logger.warn(`[diagnostics] 配置收集失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. 系统信息
    writeFileSync(
      join(staging, 'system-info.txt'),
      buildSystemInfo({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? '-',
        nodeVersion: process.versions.node ?? '-',
        osType: process.platform,
        osRelease: release(),
        userDataDir: userData,
        generatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    // 4. 打包(测试可关闭)
    if (deps.zip !== false) {
      const outputDir = deps.outputDir ?? join(userData, 'diagnostics');
      mkdirSync(outputDir, { recursive: true });
      const zipPath = join(outputDir, `diagnostics-${stamp}.zip`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Path "${staging}\\*" -DestinationPath "${zipPath}" -Force`,
          ],
          { windowsHide: true },
        );
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Compress-Archive 退出码 ${code}`))));
        child.on('error', reject);
      });
      logger.info(`[diagnostics] 诊断包已导出: ${zipPath}`);
      return zipPath;
    }
    return staging;
  } finally {
    // 打包完成后清理暂存目录(zip=false 测试模式保留)
    if (deps.zip !== false) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* 清理失败可忽略 */
      }
    }
  }
}
