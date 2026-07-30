/**
 * 素材扫描器
 * 职责:遍历指定文件夹,识别受支持素材文件并产出 MaterialMeta 列表
 * 支持扩展名:MP4/MOV(video)、MP3(audio)、TXT(text)、SRT(subtitle)
 * 注意:扫描器只读取文件系统信息,不负责 folderId 注入(由调用方拼装)
 */
import { promises as fs } from 'fs';
import { extname, join, basename, relative } from 'path';
import { randomUUID } from 'crypto';
import type { MaterialKind, MaterialMeta } from '../../../shared/types';

/**
 * 扩展名到素材类型的映射表(小写)
 * 暴露导出便于单测验证白名单边界
 */
export const EXT_KIND_MAP: Record<string, MaterialKind> = {
  '.mp4': 'video',
  '.mov': 'video',
  '.mp3': 'audio',
  '.txt': 'text',
  '.srt': 'subtitle',
};

/**
 * 判断给定文件名是否为受支持的素材类型
 * @param fileName 文件名(含扩展名)
 * @returns 命中的素材类型,未命中返回 undefined
 */
export function detectMaterialKind(fileName: string): MaterialKind | undefined {
  const ext = extname(fileName).toLowerCase();
  return EXT_KIND_MAP[ext];
}

/**
 * 递归扫描文件夹下所有受支持的素材文件
 * 采用深度优先遍历,跳过无法访问的子目录(记录为忽略,不抛错)
 * @param folderPath 文件夹绝对路径
 * @returns 扫描到的素材元数据列表(按路径字典序排序,保证可复现)
 */
export async function scanDirectory(folderPath: string): Promise<Omit<MaterialMeta, 'folderId'>[]> {
  const results: Omit<MaterialMeta, 'folderId'>[] = [];

  /**
   * 内部递归函数:遍历单个目录
   * @param currentDir 当前目录绝对路径
   */
  async function walk(currentDir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // 目录不可读:跳过而非中断整个扫描
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const kind = detectMaterialKind(entry.name);
      if (!kind) continue;

      // 获取文件 stat(可能失败,失败时 size/createdAt 留空)
      let sizeBytes: number | undefined;
      let mtime: Date | undefined;
      try {
        const stat = await fs.stat(fullPath);
        sizeBytes = stat.size;
        mtime = stat.mtime;
      } catch {
        // 文件被并发删除等情况:跳过元数据采集但仍登记
      }

      results.push({
        id: randomUUID(),
        path: fullPath,
        name: entry.name,
        kind,
        sizeBytes,
        createdAt: mtime ? mtime.toISOString() : new Date().toISOString(),
      });
    }
  }

  await walk(folderPath);

  // 按相对路径字典序排序,保证扫描结果可复现
  results.sort((a, b) =>
    relative(folderPath, a.path).localeCompare(relative(folderPath, b.path)),
  );

  return results;
}

/**
 * 取文件夹的显示名(末尾 basename)
 * @param folderPath 文件夹绝对路径
 * @returns basename 字符串
 */
export function deriveFolderName(folderPath: string): string {
  return basename(folderPath) || folderPath;
}
