/**
 * Electron 启动引导文件
 * 职责:在运行时注册 TypeScript 路径别名(@main/* @shared/*),然后加载主进程
 * 原因:tsc 编译器不会转换 paths 别名,此处手动 patch Node 模块解析
 */
import { join } from 'path';
import Module from 'module';

// 项目根目录(dist-electron/electron/ 上溯两级)
const projectRoot = join(__dirname, '..', '..');

// 路径别名 → 编译产物物理路径映射(dist-electron 下的编译输出)
const aliasMap: Record<string, string> = {
  '@main/': join(projectRoot, 'dist-electron', 'src', 'main') + '/',
  '@shared/': join(projectRoot, 'dist-electron', 'src', 'shared') + '/',
};

// 保存原始 resolveFilename
const originalResolve = (Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename;

// Patch 模块解析:拦截 @main/* 和 @shared/* 前缀,重定向到编译产物路径
(Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename = function (
  this: unknown,
  request: string,
  ...rest: unknown[]
): string {
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (request.startsWith(alias)) {
      const resolved = target + request.slice(alias.length);
      return originalResolve.call(this, resolved, ...rest);
    }
  }
  return originalResolve.call(this, request, ...rest);
} as (...args: unknown[]) => string;

// 加载主进程入口
require('./main');
