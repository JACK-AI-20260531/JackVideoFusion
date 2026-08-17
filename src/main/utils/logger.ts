/**
 * Winston 日志器单例
 * 职责:统一日志格式、按日切割、向渲染层广播
 *       通过 monkey-patch 包装 info/warn/error/debug 方法,
 *       在写入文件的同时调用 broadcastLog 推送到所有渲染窗口
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { app } from 'electron';
import { join } from 'path';
import { broadcastLog } from '../services/common/log-broadcaster';
import type { LogEntry } from '@shared/types';

// 日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}] ${message}`),
);

// 日志目录
const logDir = join(app?.getPath?.('userData') ?? process.cwd(), 'logs');

// 全局日志器单例
const winstonLogger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: logFormat,
  transports: [
    // 控制台输出
    new winston.transports.Console(),
    // 按日切割文件(使用直接导入的 DailyRotateFile,兼容 CJS 编译)
    new DailyRotateFile({
      dirname: logDir,
      filename: 'jvf-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
    }),
  ],
});

/**
 * 从日志消息前缀推断来源模块
 * 消息格式如 "[FFmpeg] xxx" → "ffmpeg"、"[ConfigService] xxx" → "common"
 * @param message 日志消息
 * @returns 模块标识;无法推断时返回 undefined
 */
function parseModule(message: string): string | undefined {
  const match = message.match(/^\[([^\]]+)\]/);
  if (!match) return undefined;
  const tag = match[1].toLowerCase();
  if (tag.includes('ffmpeg')) return 'ffmpeg';
  if (tag.includes('tts')) return 'tts';
  if (tag.includes('material')) return 'material';
  if (tag.includes('video-mix') || tag.includes('videomix')) return 'video-mix';
  return 'common';
}

/**
 * 构造日志条目并广播到渲染层
 * @param level 日志级别
 * @param message 日志消息(可能为非字符串,统一转为字符串)
 */
function broadcastEntry(level: LogEntry['level'], message: unknown): void {
  const msg = typeof message === 'string' ? message : String(message ?? '');
  broadcastLog({
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    module: parseModule(msg),
  });
}

// 保存原始方法引用(绑定 this 避免 context 丢失)
const origInfo = winstonLogger.info.bind(winstonLogger);
const origWarn = winstonLogger.warn.bind(winstonLogger);
const origError = winstonLogger.error.bind(winstonLogger);
const origDebug = winstonLogger.debug.bind(winstonLogger);

// monkey-patch:在原始日志写入后追加渲染层广播
// 用括号包裹箭头函数,避免返回类型注解与 as 断言产生解析歧义
winstonLogger.info = ((message: string, ...meta: unknown[]) => {
  origInfo(message, ...meta);
  broadcastEntry('info', message);
  return winstonLogger;
}) as typeof winstonLogger.info;

winstonLogger.warn = ((message: string, ...meta: unknown[]) => {
  origWarn(message, ...meta);
  broadcastEntry('warn', message);
  return winstonLogger;
}) as typeof winstonLogger.warn;

winstonLogger.error = ((message: string, ...meta: unknown[]) => {
  origError(message, ...meta);
  broadcastEntry('error', message);
  return winstonLogger;
}) as typeof winstonLogger.error;

winstonLogger.debug = ((message: string, ...meta: unknown[]) => {
  origDebug(message, ...meta);
  broadcastEntry('debug', message);
  return winstonLogger;
}) as typeof winstonLogger.debug;

/** 导出日志器单例(已包装广播能力) */
export const logger = winstonLogger;
