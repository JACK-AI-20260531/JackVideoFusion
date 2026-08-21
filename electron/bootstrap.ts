/**
 * Electron 启动引导文件
 * 职责:在运行时注册 TypeScript 路径别名(@main/* @shared/*),然后加载主进程
 * 原因:tsc 编译器不会转换 paths 别名,此处手动 patch Node 模块解析
 *
 * 额外处理:electron-builder 打 asar 时可能把某些依赖嵌套到非顶层 node_modules,
 *          导致其他包 require 找不到。此处增加 fallback:若原始解析失败,
 *          尝试从 app 根目录的 node_modules 查找。
 */
import { join } from 'path';
import Module from 'module';
import { existsSync } from 'fs';

// 项目根目录(dist-electron/electron/ 上溯两级 = app.asar 根)
const projectRoot = join(__dirname, '..', '..');

// 路径别名 → 编译产物物理路径映射(dist-electron 下的编译输出)
const aliasMap: Record<string, string> = {
  '@main/': join(projectRoot, 'dist-electron', 'src', 'main') + '/',
  '@shared/': join(projectRoot, 'dist-electron', 'src', 'shared') + '/',
};

// 保存原始 resolveFilename
const originalResolve = (Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename;

/**
 * Patch 模块解析:
 * 1. 拦截 @main/* 和 @shared/* 前缀,重定向到编译产物路径
 * 2. 若原始解析失败且请求不是相对路径/,尝试从 app 根目录 node_modules 查找
 *    (修复 electron-builder 将依赖嵌套到子包 node_modules 导致的找不到问题)
 */
(Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename = function (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: unknown,
  options: unknown,
): string {
  // 1. 别名解析
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (request.startsWith(alias)) {
      const resolved = target + request.slice(alias.length);
      return originalResolve.call(this, resolved, parent, isMain, options);
    }
  }

  // 2. 尝试原始解析
  try {
    return originalResolve.call(this, request, parent, isMain, options);
  } catch (err) {
    // 3. Fallback:若是非相对路径模块且解析失败,从 app 根 node_modules 查找
    if (!request.startsWith('.') && !request.startsWith('/') && !request.startsWith('@main/') && !request.startsWith('@shared/')) {
      const fallbackPath = join(projectRoot, 'node_modules', request);
      try {
        return originalResolve.call(this, fallbackPath, parent, isMain, options);
      } catch {
        // fallback 也失败,抛出原始错误
      }
    }
    throw err;
  }
} as (...args: unknown[]) => string;

// 加载主进程入口
require('./main');
