/**
 * CN-CLIP 中文 wordpiece 分词器
 *
 * 职责:加载 CN-CLIP 的 vocab.txt(中文 BERT 词表,21128 词),对中文文本做
 *      wordpiece 切分,产出模型输入所需的 token id 序列。
 * 纯函数/无 electron 依赖(词表内容由外部注入),可独立单元测试。
 *
 * 约定(与 ondevice/cn-clip-onnx config.json 一致):
 *   - pad_token_id = 0, bos_token_id = 0, eos_token_id = 2
 *   - 文本最大长度 512(含 BOS/EOS)
 *   - 未登录词(char)回退到 [UNK] token id 100
 */

/** CN-CLIP 文本最大长度(含特殊 token) */
export const CN_TEXT_MAX_LEN = 512;
/** 未知词 token id(CN-CLIP vocab 中的 [UNK]) */
export const CN_UNK_ID = 100;
/** wordpiece 前缀标识(CN-CLIP/BERT 使用 ##) */
const WORD_PIECE_PREFIX = '##';

/**
 * 从 vocab.txt 文本内容构建 tokenizer。
 * vocab.txt 每行一个 token(special tokens 在最前)。
 * @param content vocab.txt 文件内容
 * @returns { encode } 分词编码函数
 */
export function createChineseTokenizer(content: string) {
  // 词表:token → id
  const vocab = new Map<string, number>();
  const tokens = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  tokens.forEach((tok, idx) => {
    if (!vocab.has(tok)) vocab.set(tok, idx);
  });

  // 预计算最长子词匹配的排序表:按长度降序(优先匹配更长的词)
  const sortedTokens = [...vocab.keys()].sort((a, b) => b.length - a.length);
  // 词表 id 上限(用于 UNK 回退检查)
  const vocabSize = vocab.size;

  /**
   * 对单个 word 做最长优先的子词切分(贪心 wordpiece)
   * @param word 单词
   * @returns token id 数组;切分不完整时返回 []
   */
  function wordPiece(word: string): number[] {
    if (word.length === 0) return [];
    const ids: number[] = [];
    let start = 0;
    let first = true;
    while (start < word.length) {
      // 从当前位置向后,尽量匹配长词;首个字符不加 ##,其余加 ##
      let matched = false;
      const remaining = word.length - start;
      // 最长尝试(限制扫描,避免 O(n^2) 过大)
      const maxScan = Math.min(remaining, 20);
      for (let len = maxScan; len >= 1; len--) {
        if (start + len > word.length) continue;
        let sub = word.slice(start, start + len);
        if (!first) sub = WORD_PIECE_PREFIX + sub;
        const id = vocab.get(sub);
        if (id !== undefined) {
          ids.push(id);
          start += len;
          first = false;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 无法切分 → 回退 UNK(单字符兜底),整体标为未切分
        ids.push(CN_UNK_ID);
        start += 1;
        first = false;
      }
    }
    return ids;
  }

  /**
   * 将文本编码为模型输入序列
   * 对中文按字符边界切成"word",每个字符/连续英文串做 wordpiece。
   * 输出: [bos] + tokens + [eos] + padding(max 512)
   * @param text 输入文本
   * @returns 长度为 CN_TEXT_MAX_LEN 的 Int32Array token ids
   */
  function encodeToTokens(text: string): Int32Array {
    const out = new Int32Array(CN_TEXT_MAX_LEN);
    const src = (text ?? '').normalize('NFC');
    out[0] = 0; // bos_token_id

    let pos = 1;
    // 逐"word"处理:中文单字一个 word,英文/数字连续串一个 word,空白忽略
    let i = 0;
    const n = src.length;
    while (i < n && pos < CN_TEXT_MAX_LEN - 1) {
      const ch = src[i];
      // 跳过空白
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      // 中文(或任意非 ASCII 字母数字,含 CJK)按单字成 word
      if (/[\u0000-\u00FF]/.test(ch)) {
        // ASCII 字母/数字 → 汇聚成连续串
        let j = i;
        const buf: string[] = [];
        while (j < n && /[A-Za-z0-9]/.test(src[j])) {
          buf.push(src[j]);
          j += 1;
        }
        if (buf.length > 0) {
          const ids = wordPiece(buf.join(''));
          for (const id of ids) {
            if (pos >= CN_TEXT_MAX_LEN - 1) break;
            out[pos++] = id;
          }
          i = j;
          continue;
        }
        // 其他 ASCII 符号(punctuation)→ 单字符 word
        const ids = wordPiece(ch);
        for (const id of ids) {
          if (pos >= CN_TEXT_MAX_LEN - 1) break;
          out[pos++] = id;
        }
        i += 1;
        continue;
      }
      // 非 ASCII(中文等)单字成 word
      const ids = wordPiece(ch);
      for (const id of ids) {
        if (pos >= CN_TEXT_MAX_LEN - 1) break;
        out[pos++] = id;
      }
      i += 1;
    }

    out[pos] = 2; // eos_token_id
    return out;
  }

  return {
    encodeToTokens,
    vocabSize,
    vocab,
  };
}

/** 单例缓存:避免每次推理重复解析词表字符串 */
let cachedTokenizer: ReturnType<typeof createChineseTokenizer> | null = null;

/**
 * 从 vocab.txt 内容解析并缓存分词器,返回编码函数
 * @param vocabContent vocab.txt 内容
 * @returns token id 序列生成器
 */
export function getCachedTokenizer(vocabContent: string) {
  if (!cachedTokenizer) {
    cachedTokenizer = createChineseTokenizer(vocabContent);
  }
  return cachedTokenizer;
}
