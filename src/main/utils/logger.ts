/**
 * Winston 日志器单例
 * 职责:统一日志格式、按日切割、向渲染层广播
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { app } from 'electron';
import { join } from 'path';

// 日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}] ${message}`),
);

// 日志目录
const logDir = join(app?.getPath?.('userData') ?? process.cwd(), 'logs');

// 全局日志器单例
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: logFormat,
  transports: [
    // 控制台输出
    new winston.transports.Console(),
    // 按日切割文件
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'jvf-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
    }),
  ],
});
