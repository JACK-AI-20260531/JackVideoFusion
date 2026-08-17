/**
 * 剪贴板复制纯函数
 * 职责:判断文本是否可复制,并承担实际的剪贴板写入(带降级)
 */

/**
 * 判断文本是否可复制(非空且非纯空白)
 * @param text 待复制文本
 * @returns 是否可复制
 */
export function isCopyable(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * 复制文本:空文本不触发任何操作并返回 false
 * @param text 待复制文本
 * @returns 是否成功写入剪贴板
 */
export async function shouldCopy(text: unknown): Promise<boolean> {
  if (!isCopyable(text)) {
    return false;
  }
  return copy(text);
}

/**
 * 将文本写入剪贴板(优先 Web Clipboard API,失败降级为 execCommand)
 * @param text 非空文本
 * @returns 是否写入成功
 */
async function copy(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试降级方案 */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
