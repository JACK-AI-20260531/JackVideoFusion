/**
 * 感知哈希 dHash(PRD-v1.7 数据飞轮与全景矩阵 FR-5)
 *
 * 职责:9x8 灰度像素 → 64 位 dHash;汉明距离比较;重复判定
 * 设计要点:
 *   - 纯函数,不依赖 electron/ffmpeg;像素由调用方经 ffmpeg 抽取
 *   - dHash 规则:每行内相邻像素比较,左 > 右 → 1;8 行 × 8 次 = 64 位,输出 16 位 hex
 *   - 重复判定:汉明距离 ≤ 8(64 位中允许 12.5% 位差,容忍转码/水印扰动)
 */

/** dHash 列数(9 列产生 8 次相邻比较) */
export const DHASH_COLS = 9;
/** dHash 行数 */
export const DHASH_ROWS = 8;
/** 期望的灰度字节数(cols × rows) */
export const DHASH_PIXELS = DHASH_COLS * DHASH_ROWS;
/** 重复判定阈值:汉明距离 ≤ 8 视为重复 */
export const DUPLICATE_HASH_DISTANCE = 8;

/** 十六进制字符 → 4 位比特的查表(解析用) */
const HEX_TO_BITS: Record<string, string> = {
  '0': '0000', '1': '0001', '2': '0010', '3': '0011',
  '4': '0100', '5': '0101', '6': '0110', '7': '0111',
  '8': '1000', '9': '1001', a: '1010', b: '1011',
  c: '1100', d: '1101', e: '1110', f: '1111',
};

/** 单个半字节(SIMD 查表)的置位数:0-15 → 各位置 1 的个数 */
const POPCOUNT_NIBBLE: Record<string, number> = {
  '0': 0, '1': 1, '2': 1, '3': 2,
  '4': 1, '5': 2, '6': 2, '7': 3,
  '8': 1, '9': 2, a: 2, b: 3,
  c: 2, d: 3, e: 3, f: 4,
};

/**
 * 由灰度像素计算 dHash(64 位,16 字符 hex)
 * @param pixels 灰度像素序列(行优先,长度须为 cols×rows=72)
 * @param cols 列数(默认 9)
 * @param rows 行数(默认 8)
 * @returns 64 位哈希(16 字符小写 hex);像素数不符返回空串
 */
export function dHash64(
  pixels: Uint8Array | number[],
  cols = DHASH_COLS,
  rows = DHASH_ROWS,
): string {
  if (pixels.length !== cols * rows) return '';
  let bits = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const left = pixels[r * cols + c];
      const right = pixels[r * cols + c + 1];
      bits += left > right ? '1' : '0';
    }
  }
  // 64 位 → 16 个 hex 字符
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * 两个 hex 哈希的汉明距离
 * @param a 哈希 A(16 字符 hex)
 * @param b 哈希 B(16 字符 hex)
 * @returns 比特差异个数;长度不符返回 Number.MAX_SAFE_INTEGER
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const na = a[i].toLowerCase();
    const nb = b[i].toLowerCase();
    if (!(na in HEX_TO_BITS) || !(nb in HEX_TO_BITS)) return Number.MAX_SAFE_INTEGER;
    const bitsA = HEX_TO_BITS[na];
    const bitsB = HEX_TO_BITS[nb];
    for (let k = 0; k < 4; k++) {
      if (bitsA[k] !== bitsB[k]) dist++;
    }
  }
  return dist;
}

/**
 * 判断两个哈希是否重复
 * @param a 哈希 A
 * @param b 哈希 B
 * @param maxDistance 最大汉明距离(默认 8)
 */
export function isDuplicate(
  a: string,
  b: string,
  maxDistance = DUPLICATE_HASH_DISTANCE,
): boolean {
  return hammingDistance(a, b) <= maxDistance;
}
