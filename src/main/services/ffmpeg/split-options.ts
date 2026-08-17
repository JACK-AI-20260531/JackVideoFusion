/**
 * 分割选项解析纯函数
 * 职责:把界面选项(保留原画质/去原声/命名规则)映射为 ffmpeg 分割选项,
 *       并生成 segment 分离器的 ffmpeg 输出参数
 */
import type { SplitOpts } from './types';

/**
 * 界面分割选项的输入
 */
export interface SplitUiOpts {
  /** 是否保留原画质 */
  keepQuality?: boolean;
  /** 是否去除原声 */
  stripAudio?: boolean;
  /** 命名规则模板({name}=原文件名, {index}=序号) */
  namingRule?: string;
  /** 输入文件名(不含扩展名),用于 {name} 占位符 */
  inputName?: string;
}

/**
 * 把界面选项解析为最终 SplitOpts
 * 语义:
 *   - 保留原画质 → 关键帧快速分割(precise=false)
 *   - 不保留原画质 → 精确重编码(precise=true)
 *   - 去原声 → stripAudio
 *   - 命名规则 → 取 {index} 之前的文本作为 prefix,{name} 替换为输入名
 * @param ui 界面选项
 * @returns 归一化后的分割选项
 */
export function resolveSplitOpts(ui: SplitUiOpts): SplitOpts {
  const opts: SplitOpts = {
    precise: ui.keepQuality ? false : true,
    stripAudio: ui.stripAudio ?? false,
  };

  if (ui.namingRule) {
    const prefix = resolvePrefix(ui.namingRule, ui.inputName ?? '');
    if (prefix) {
      opts.prefix = prefix;
    }
  }

  return opts;
}

/**
 * 从命名规则模板解析 prefix(即 {index} 之前的文本,{name} 替换为输入名)
 * @param template 命名规则模板
 * @param inputName 输入文件名(不含扩展名)
 * @returns prefix 文本,无有效命名部分时返回空字符串
 */
function resolvePrefix(template: string, inputName: string): string {
  const idxMarker = '{index}';
  const idxPos = template.indexOf(idxMarker);
  if (idxPos === -1) {
    return '';
  }
  const before = template.slice(0, idxPos).replace('{name}', inputName);
  return before;
}

/**
 * 生成 segment 分离器的 ffmpeg 输出参数
 * @param opts 分割选项
 * @returns ffmpeg 输出选项数组
 */
export function buildSegmentOutputOptions(opts: {
  precise?: boolean;
  stripAudio?: boolean;
}): string[] {
  const output: string[] = [];
  if (!opts.precise) {
    output.push('-c', 'copy', '-map', '0');
  }
  if (opts.stripAudio) {
    output.push('-an');
  }
  return output;
}
