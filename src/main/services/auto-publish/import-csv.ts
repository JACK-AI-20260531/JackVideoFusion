/**
 * CSV 批量任务清单导入(PRD-发布闭环与素材兜底 FR-3)
 *
 * 职责:
 *   - 自实现 CSV 解析(引号转义/引号内逗号换行/BOM,不引第三方库)
 *   - 表头别名映射(中英文)→ 行对象;逐行校验(失败隔离)
 *   - 定时时间支持 ISO 或 yyyy-MM-dd HH:mm;过去时间判为错误
 *   - 文件编码:BOM 检测 UTF-8,否则按 GBK 解码
 *
 * 设计约定:parseCsvText / rowsToTasks / buildCsvTemplate 为纯函数,可独立单测;
 *          文件存在性校验经 fileExists 注入,默认 existsSync
 */
import { existsSync, readFileSync } from 'fs';
import type { PublishPlatform } from './types';
import { PLATFORM_NAMES } from './adapters';
import { validatePublishSpec, specBlockMessage } from './publish-spec';

/** 清单行(校验通过) */
export interface CsvTaskRow {
  videoPath: string;
  platform: PublishPlatform;
  title: string;
  description?: string;
  tags?: string[];
  coverPath?: string;
  scheduledAt?: string;
}

/** 校验失败的行 */
export interface CsvRowError {
  /** 数据行号(从 2 起,1 为表头) */
  line: number;
  /** 失败原因 */
  reason: string;
}

/** 解析结果 */
export interface CsvParseResult {
  rows: CsvTaskRow[];
  errors: CsvRowError[];
  /** 数据行总数(不含表头) */
  total: number;
}

/**
 * 解析 CSV 文本为二维表(处理引号转义/引号内逗号与换行)
 * @param text CSV 原始文本
 * @returns 二维表(首行为表头)
 */
export function parseCsvText(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        // 双引号转义: "" → "
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      table.push(row);
      row = [];
    } else if (ch === '\r') {
      // 忽略 \r(由 \n 统一处理换行)
    } else {
      field += ch;
    }
  }
  // 末行(无换行结尾)
  row.push(field);
  table.push(row);
  return table.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/** 表头别名映射(小写化比对) */
const HEADER_ALIASES: Record<string, string[]> = {
  videoPath: ['videopath', '视频路径', '视频文件'],
  platform: ['platform', '平台'],
  title: ['title', '标题'],
  description: ['description', '描述'],
  tags: ['tags', '标签', '话题'],
  coverPath: ['coverpath', '封面'],
  scheduledAt: ['scheduledat', '定时时间', '发布时间'],
};

/** 平台别名 → 平台标识(中英文) */
const PLATFORM_ALIASES: Record<string, PublishPlatform> = {
  douyin: 'douyin',
  抖音: 'douyin',
  kuaishou: 'kuaishou',
  快手: 'kuaishou',
  xiaohongshu: 'xiaohongshu',
  小红书: 'xiaohongshu',
  bilibili: 'bilibili',
  b站: 'bilibili',
  shipinhao: 'shipinhao',
  视频号: 'shipinhao',
};

/**
 * 解析定时时间:ISO 或 yyyy-MM-dd HH:mm(按本地时区)
 * @param text 原始文本(可空)
 * @returns ISO 字符串;空返回 undefined;非法/过期抛错由调用方处理为行错误
 */
export function parseScheduledAt(text: string | undefined, now: number): string | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const t = text.trim().replace('T', ' ');
  // yyyy-MM-dd HH(:mm(:ss)?) 兼容:补秒;不带时区 → 按本地时区解析
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}(:\d{2})?(:\d{2})?$/.test(t)
    ? t.replace(' ', 'T') + (t.split(':').length === 2 ? ':00' : '')
    : t;
  const time = new Date(normalized).getTime();
  if (isNaN(time)) throw new Error(`定时时间格式非法: ${text}`);
  if (time <= now) throw new Error('定时时间已过去');
  return new Date(time).toISOString();
}

/**
 * 二维表 → 校验后的任务行
 * @param table CSV 二维表(首行表头)
 * @param opts fileExists 文件存在性校验(默认 existsSync)/ now 当前时间
 * @returns 合法行 + 错误列表 + 总行数
 */
export function rowsToTasks(
  table: string[][],
  opts: {
    fileExists?: (p: string) => boolean;
    now?: number;
    platformExists?: (p: string) => boolean;
  } = {},
): CsvParseResult {
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));
  const platformExists = opts.platformExists ?? ((p: string) => p in PLATFORM_ALIASES);
  const now = opts.now ?? Date.now();
  const errors: CsvRowError[] = [];
  const rows: CsvTaskRow[] = [];

  if (table.length === 0) return { rows, errors, total: 0 };

  // 表头 → 字段下标映射(别名归一化)
  const header = table[0].map((h) => h.trim().toLowerCase());
  const indexOf = (field: string): number => {
    const aliases = HEADER_ALIASES[field] ?? [field];
    for (const alias of aliases) {
      const idx = header.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const col = {
    videoPath: indexOf('videoPath'),
    platform: indexOf('platform'),
    title: indexOf('title'),
    description: indexOf('description'),
    tags: indexOf('tags'),
    coverPath: indexOf('coverPath'),
    scheduledAt: indexOf('scheduledAt'),
  };
  if (col.videoPath < 0 || col.platform < 0 || col.title < 0) {
    throw new Error('CSV 缺少必需列:videoPath / platform / title');
  }

  const cell = (row: string[], idx: number): string | undefined => {
    const v = idx >= 0 && idx < row.length ? row[idx].trim() : '';
    return v.length > 0 ? v : undefined;
  };

  const dataRows = table.slice(1);
  dataRows.forEach((dataRow, i) => {
    const line = i + 2;
    try {
      const videoPath = cell(dataRow, col.videoPath);
      const platformRaw = cell(dataRow, col.platform);
      const title = cell(dataRow, col.title);
      if (!videoPath) throw new Error('视频路径不能为空');
      if (!title) throw new Error('标题不能为空');
      if (!platformRaw) throw new Error('平台不能为空');
      const platformKey = platformRaw.toLowerCase();
      if (!platformExists(platformKey)) {
        throw new Error(`平台不支持: ${platformRaw}(可用: ${Object.values(PLATFORM_NAMES).join('/')})`);
      }
      if (!fileExists(videoPath)) {
        throw new Error(`视频文件不存在: ${videoPath}`);
      }
      const scheduledAt = parseScheduledAt(cell(dataRow, col.scheduledAt), now);
      const tagsRaw = cell(dataRow, col.tags);
      const rowParams = {
        videoPath,
        platform: PLATFORM_ALIASES[platformKey],
        title,
        description: cell(dataRow, col.description),
        tags: tagsRaw
          ? tagsRaw
              .split(/[;；]/)
              .map((t) => t.trim())
              .filter((t) => t.length > 0)
          : undefined,
        coverPath: cell(dataRow, col.coverPath),
        scheduledAt,
      };
      // 平台规格预检(标题/标签约束,不合规阻断;PRD-v1.7 FR-4)
      const blockMsg = specBlockMessage(validatePublishSpec(rowParams));
      if (blockMsg) throw new Error(blockMsg);
      rows.push(rowParams);
    } catch (err) {
      errors.push({ line, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  return { rows, errors, total: dataRows.length };
}

/**
 * 生成 CSV 模板文本(表头 + 2 行示例)
 * @returns CSV 文本
 */
export function buildCsvTemplate(): string {
  const header = 'videoPath,platform,title,description,tags,coverPath,scheduledAt';
  const example1 = 'F:\\videos\\demo1.mp4,抖音,第一条视频,这是描述,搞笑;日常,,2026-10-01 18:00';
  const example2 = 'F:\\videos\\demo2.mp4,B站,第二条视频,,教程,,';
  return `${header}\n${example1}\n${example2}\n`;
}

/**
 * 读取 CSV 文件并解码为文本:BOM 检测 UTF-8,否则按 GBK 解码
 * @param filePath CSV 文件路径
 * @returns 解码后的文本
 */
export function readCsvText(filePath: string): string {
  const buf = readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  try {
    // Node 全量 ICU 支持 GBK 解码
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}
