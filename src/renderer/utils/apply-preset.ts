/**
 * 模板套用到表单的纯函数
 * 职责:把模板业务参数安全覆盖到表单默认值——只覆盖"默认值里已存在"的键,
 *      并对 number↔string 做容错强转(字符串数字可转回 number),其余类型不符保留 fallback
 */

/**
 * 将模板参数套用到表单默认值
 * @param fallback 表单目前的默认值(提供基准与类型约束)
 * @param preset 模板业务参数(可能缺失/含未知键/类型不符)
 * @returns 新的表单值(不修改入参)
 */
export function applyPreset<T extends Record<string, unknown>>(
  fallback: T,
  preset: Partial<T> | Record<string, unknown> | undefined | null,
): T {
  const result = { ...fallback };
  if (!preset || typeof preset !== 'object') {
    return result;
  }
  const record = preset as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const presetValue = record[key];
    if (presetValue === undefined || presetValue === null) continue;
    // 仅当 fallback 存在同键才考虑覆盖
    if (!(key in fallback)) continue;
    const fallbackValue = fallback[key];
    // number↔string 容错:fallback 为 number,preset 为可解析的数字字符串时强转为 number
    if (
      typeof fallbackValue === 'number' &&
      typeof presetValue === 'string' &&
      /^-?\d+(\.\d+)?$/.test(presetValue.trim())
    ) {
      (result as Record<string, unknown>)[key] = Number(presetValue);
      continue;
    }
    // 其余情况仅当类型一致才覆盖
    if (typeof presetValue === typeof fallbackValue) {
      (result as Record<string, unknown>)[key] = presetValue;
    }
  }
  return result;
}
