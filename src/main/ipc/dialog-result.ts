/**
 * 对话框路径返回值
 */
export interface DialogPathResult {
  path: string;
}

/**
 * 对话框多路径返回值
 */
export interface DialogPathsResult {
  paths: string[];
}

/**
 * 将打开单文件结果归一化为前端稳定契约
 * @param canceled 用户是否取消选择
 * @param filePaths Electron 返回的路径数组
 * @returns 单路径对象,取消或无路径时返回 null
 */
export function normalizeOpenFileResult(
  canceled: boolean,
  filePaths: string[],
): DialogPathResult | null {
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return { path: filePaths[0] };
}

/**
 * 将打开多文件结果归一化为前端稳定契约
 * @param canceled 用户是否取消选择
 * @param filePaths Electron 返回的路径数组
 * @returns 多路径对象,取消或无路径时返回 null
 */
export function normalizeOpenFilesResult(
  canceled: boolean,
  filePaths: string[],
): DialogPathsResult | null {
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return { paths: filePaths };
}

/**
 * 将打开目录结果归一化为前端稳定契约
 * @param canceled 用户是否取消选择
 * @param filePaths Electron 返回的路径数组
 * @returns 单路径对象,取消或无路径时返回 null
 */
export function normalizeOpenDirectoryResult(
  canceled: boolean,
  filePaths: string[],
): DialogPathResult | null {
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return { path: filePaths[0] };
}

/**
 * 将保存文件结果归一化为前端稳定契约
 * @param canceled 用户是否取消选择
 * @param filePath Electron 返回的保存路径
 * @returns 单路径对象,取消或无路径时返回 null
 */
export function normalizeSaveFileResult(
  canceled: boolean,
  filePath?: string,
): DialogPathResult | null {
  if (canceled || !filePath) {
    return null;
  }
  return { path: filePath };
}
