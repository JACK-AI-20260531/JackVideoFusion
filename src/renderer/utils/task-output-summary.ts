/**
 * 判断值是否为普通对象
 * @param value 待判断的值
 * @returns 是否为键值对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读取对象里的字符串字段
 * @param value 来源对象
 * @param key 字段名
 * @returns 字符串字段值,不存在则返回空字符串
 */
function readStringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : '';
}

/**
 * 将任务输出结果转换为用户可读摘要
 * @param output 任务输出数据
 * @param error 任务失败原因
 * @returns 可展示的短摘要文本
 */
export function summarizeTaskOutput(output: unknown, error?: string): string {
  if (error) {
    return `错误:${error}`;
  }

  if (typeof output === 'string' && output.length > 0) {
    return `输出:${output}`;
  }

  if (Array.isArray(output)) {
    return output.length > 0 ? `结果:${output.length} 项` : '';
  }

  if (!isRecord(output)) {
    return '';
  }

  const outputPath = readStringField(output, 'outputPath');
  if (outputPath) {
    return `输出:${outputPath}`;
  }

  const audioPath = readStringField(output, 'audioPath');
  const srtPath = readStringField(output, 'srtPath');
  const parts = [
    audioPath ? `音频:${audioPath}` : '',
    srtPath ? `字幕:${srtPath}` : '',
  ].filter(Boolean);

  return parts.join(' | ');
}
