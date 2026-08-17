/**
 * 逐镜头配音脚本分配 + 语速估算纯函数
 *
 * 职责:
 *   1. 把解说文案按句号/换行切分为段落,并按参考镜头时长分配到每个镜头
 *   2. 提供更精准的"文本 → 预估朗读时长"模型(区分中文/英文/数字/标点)
 *   3. 提供初始语速估算与迭代纠偏(双向匹配:超时加快、过短放慢)
 *
 * 设计约定(对应方案 A「逐镜头配音对齐」的语速优化):
 *   - 纯函数,不依赖 electron / ffmpeg / tts 实例,可独立单元测试
 *   - 段落分配:段落数 ≤ 镜头数 → 每镜头一段;> 镜头数 → 多余段落并入末镜头
 *   - 时长估算:以"内容感知"的字符→秒模型替代固定 4.5 字符/秒
 *   - 语速纠偏:按「实际时长 / 目标时长」比例修正 rate,双向 clamp 并收敛
 */

/** 中文汉字默认朗读语速(字符/秒),作为中文时长的基准 */
const CJK_CHARS_PER_SEC = 4.5;

/**
 * 单个英文单词的预估朗读时长(秒)。
 * 英文单词平均约 2.5~3 音节、自然读速 150~160 wpm → 约 0.35~0.4s/词
 */
const WORD_SECONDS = 0.35;

/**
 * 单个数字字符的预估朗读时长(秒)。
 * 数字通常逐位/逐数读,平均约 6 位/秒
 */
const DIGIT_SECONDS = 0.15;

/** 句末标点(。！？…)的停顿时长(秒) */
const END_PUNCT_SECONDS = 0.45;

/** 中缀标点(,、;：)的停顿时长(秒) */
const MID_PUNCT_SECONDS = 0.18;

/** 语速 rate 的合理下限(Edge-TTS -100~100,收紧为 -20 避免拖沓) */
const RATE_MIN = -20;

/** 语速 rate 的合理上限(收紧为 60 避免失真) */
const RATE_MAX = 60;

/** 单个镜头脚本分配结果 */
export interface ShotScriptSegment {
  /** 镜头序号(从 0 开始,与参考镜头序列一致) */
  index: number;
  /** 该镜头对应的解说文本(空串表示该镜头无配音) */
  text: string;
  /** 该镜头在成片时间轴上的起点(秒) */
  startSec: number;
  /** 该镜头时长(秒) */
  durationSec: number;
}

/**
 * 把文案按句号/换行/问号/感叹号切分为段落
 * 空段落会被过滤;若切分后为空,返回空数组
 * @param script 原始文案
 * @returns 段落数组(已 trim,过滤空串)
 */
export function splitParagraphs(script: string): string[] {
  if (!script) return [];
  return script
    .split(/[。\n\r!?！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 按镜头时长把文案分配到每个镜头,生成逐镜头脚本
 * 时间轴 = 前序镜头时长累加,与参考视频节奏一致
 * @param script 解说文案
 * @param shotDurations 参考镜头时长序列(按时间顺序,单位秒)
 * @returns 逐镜头脚本分配结果(长度 = shotDurations.length,含空字幕镜头)
 */
export function assignShotScripts(
  script: string,
  shotDurations: number[],
): ShotScriptSegment[] {
  const paragraphs = splitParagraphs(script);
  const segments: ShotScriptSegment[] = [];

  let cursorSec = 0;
  for (let i = 0; i < shotDurations.length; i++) {
    const durationSec = Math.max(shotDurations[i], 0) || 0;
    const startSec = cursorSec;
    cursorSec += durationSec;

    let text = paragraphs[i] ?? '';
    // 最后一个镜头:把剩余的段落全部追加,避免文案丢失
    if (i === shotDurations.length - 1 && text.trim().length > 0) {
      const extra = paragraphs.slice(i + 1).filter((p) => p.length > 0);
      if (extra.length > 0) {
        text = [text, ...extra].filter((t) => t.length > 0).join('。');
      }
    }

    segments.push({ index: i, text, startSec, durationSec });
  }

  return segments;
}

/**
 * 估算指定文本的朗读时长(秒)
 *
 * 采用"内容感知"模型而非统一定值,以区分纯中文、含英文单词、含长数字、
 * 含大量标点的不同文案类型:
 *   - 中文汉字:每个 1/CJK_CHARS_PER_SEC 秒
 *   - 英文单词:每个 WORD_SECONDS 秒(词级,而非逐字)
 *   - 数字串:每位 DIGIT_SECONDS 秒
 *   - 句末标点(。！？…):END_PUNCT_SECONDS 秒停顿
 *   - 中缀标点(,、;：):MID_PUNCT_SECONDS 秒停顿
 *
 * @param text 待估算文本
 * @returns 预估朗读时长(秒);空文本返回 0
 */
export function estimateDurationSec(text: string): number {
  const s = (text ?? '').trim();
  if (s.length === 0) return 0;

  // 用 tokenize 规则切分:中文汉字块、英文词块、数字块、标点、其余
  const TOKEN_RE =
    /([\u4e00-\u9fff]+)|([A-Za-z]+)|(\d+)|([。！？…])|([,，、;；:：])/g;

  let seconds = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(s)) !== null) {
    if (match[1]) {
      // 中文汉字块
      seconds += match[1].length / CJK_CHARS_PER_SEC;
    } else if (match[2]) {
      // 英文单词块
      seconds += WORD_SECONDS;
    } else if (match[3]) {
      // 数字串:按位
      seconds += match[3].length * DIGIT_SECONDS;
    } else if (match[4]) {
      // 句末标点
      seconds += END_PUNCT_SECONDS;
    } else if (match[5]) {
      // 中缀标点
      seconds += MID_PUNCT_SECONDS;
    }
  }

  return seconds;
}

/**
 * 计算让指定文本在目标时长内讲完的"初始"TTS 语速 rate
 *
 * 原理:
 *   预估时长 = estimateDurationSec(text)
 *   所需语速倍率 = 预估时长 / 目标时长
 *   rate = (倍率 - 1) * 100
 *
 * 边界:
 *   - 文本为空或目标时长非正 → 返回 0(默认语速)
 *   - 结果 clamp 到 [RATE_MIN, RATE_MAX]
 *
 * @param text 段落文本
 * @param targetDurationSec 目标镜头时长(秒)
 * @returns 建议的初始 TTS rate(-100~100,已 clamp)
 */
export function computeRateForMatch(
  text: string,
  targetDurationSec: number,
): number {
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    return 0;
  }
  const estSec = estimateDurationSec(text);
  if (estSec <= 0) return 0;

  const ratio = estSec / targetDurationSec;
  const rate = Math.round((ratio - 1) * 100);
  return Math.max(RATE_MIN, Math.min(RATE_MAX, rate));
}

/**
 * 根据合成得到的实际时长,迭代纠偏 TTS 语速 rate(双向)
 *
 * 原理:朗读时长与语速近似成反比,故用"实际时长 / 目标时长"的比例修正 rate:
 *   newRate = prevRate + round(100 * (实际时长 - 目标时长) / 目标时长)
 *   - 实际 > 目标(超时)→ newRate 增大(加快)
 *   - 实际 < 目标(过短)→ newRate 减小(放慢)
 *
 * 边界:
 *   - targetSec 非正 → 返回 prevRate 不变
 *   - 结果 clamp 到 [RATE_MIN, RATE_MAX]
 *
 * @param prevRate 上一轮合成使用的 rate
 * @param actualDurationSec 上一轮合成的实际时长(秒)
 * @param targetDurationSec 目标时长(秒,即镜头时长)
 * @returns 修正后的 TTS rate(-100~100,已 clamp)
 */
export function calculateRateCorrection(
  prevRate: number,
  actualDurationSec: number,
  targetDurationSec: number,
): number {
  if (
    !Number.isFinite(targetDurationSec) ||
    targetDurationSec <= 0 ||
    !Number.isFinite(actualDurationSec)
  ) {
    return prevRate;
  }
  const delta = (actualDurationSec - targetDurationSec) / targetDurationSec;
  const nextRate = Math.round(prevRate + 100 * delta);
  return Math.max(RATE_MIN, Math.min(RATE_MAX, nextRate));
}

/** 语速 rate 上限导出(cloner 重试时使用) */
export const RATE_LIMIT = RATE_MAX;
