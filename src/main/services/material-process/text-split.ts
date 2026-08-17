/**
 * 文本分割纯函数
 * 职责:按字数/标题点拆分文本,供素材处理 TTS 语音合成前的分段使用
 *      纯 Node 字符串处理,不依赖 electron,可独立单元测试
 */

// 全部标点(中英文),用于非保留标点模式时剔除
const ALL_PUNCT_REGEX = /[，。！？；：、""''（）《》【】,.!?;:"'()<>[\]{}…—\-]/g;

/**
 * 文本分割:按字数切分,支持标点感知和自动分段
 * 算法:1) 按段落拆分(可选) → 2) 按句末标点拆句 → 3) 贪心打包至 charLimit → 4) 标点处理
 * @param text 原始文本
 * @param charLimit 单条最大字数(>0)
 * @param opts.keepPunct 是否保留标点
 * @param opts.autoParagraph 是否按段落自动分段
 * @returns 分割后的文本数组(已去空串)
 */
export function splitText(
  text: string,
  charLimit: number,
  opts: { keepPunct: boolean; autoParagraph: boolean },
): string[] {
  // 入参校验
  if (!text || charLimit <= 0) return [];

  // 第1步:按段落拆分(autoParagraph 模式下以换行为段落边界)
  const paragraphs = opts.autoParagraph
    ? text.split(/\n+/).filter((p) => p.trim().length > 0)
    : [text];

  // 第2步:按句末标点拆分句子,保留标点(lookbehind 保证标点附在句尾)
  const sentences: string[] = [];
  for (const para of paragraphs) {
    const parts = para.split(/(?<=[。！？!?.…])/).filter((s) => s.trim().length > 0);
    for (const part of parts) {
      if (part.length <= charLimit) {
        sentences.push(part);
      } else {
        // 单句超长时按 charLimit 硬切分
        for (let i = 0; i < part.length; i += charLimit) {
          sentences.push(part.slice(i, i + charLimit));
        }
      }
    }
  }

  // 第3步:贪心打包,将句子组合到不超过 charLimit 的片段中
  const segments: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length <= charLimit) {
      current += sentence;
    } else {
      if (current) segments.push(current);
      current = sentence;
    }
  }
  if (current) segments.push(current);

  // 第4步:标点处理(keepPunct=false 时剔除所有标点)
  const result = opts.keepPunct
    ? segments.map((s) => s.trim())
    : segments.map((s) => s.replace(ALL_PUNCT_REGEX, '').trim());

  return result.filter((s) => s.length > 0);
}
