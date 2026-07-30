/**
 * LLM 提示词模板
 * 职责:集中管理关键词抽取、画面匹配等场景的系统提示词与用户消息构造
 *       保证后续 AI 剪辑模块调用 LLM 时提示词一致、可维护
 */

/**
 * 关键词抽取系统提示词
 * 指导 LLM 从视频文案中抽取可用于检索匹配视频画面的实体/场景关键词,
 * 仅输出 JSON 数组,便于程序解析
 */
export const KEYWORD_EXTRACTION_SYSTEM = `你是一名视频画面匹配助手。你的任务是从用户提供的视频文案中,抽取可用于检索匹配视频画面的关键词。
抽取要求:
1. 关键词应为具体、可视化的实体或场景,如人物、物体、地点、动作、环境、氛围等。
2. 跳过抽象、情感、语气类词汇(如"快乐""非常""也许")。
3. 每个关键词用简短中文词组表达,不超过 8 个字。
4. 仅输出关键词,按 JSON 数组格式返回,如 ["关键词1","关键词2"],不要输出任何解释或额外文字。`;

/**
 * 画面匹配系统提示词
 * 指导 LLM 根据文案段落从可用画面列表中挑选最匹配的画面,
 * 仅输出 JSON 数组,便于程序解析
 */
export const SCENE_MATCH_SYSTEM = `你是一名视频画面匹配助手。你的任务是根据给定的文案段落,从可用画面列表中挑选最适合表现该段落的画面。
匹配要求:
1. 优先选择与文案语义、场景、情绪最贴合的画面。
2. 若没有完全匹配的画面,选择语义最接近的画面。
3. 仅输出选中的画面名称,按 JSON 数组格式返回,如 ["画面A","画面B"],不要输出任何解释。`;

/**
 * 构造关键词抽取的用户消息
 * @param text 待抽取的文案
 * @param maxCount 最大关键词数量(默认 10)
 * @returns 用户消息内容
 */
export function buildKeywordPrompt(text: string, maxCount = 10): string {
  return `请从以下文案中抽取最多 ${maxCount} 个可用于视频画面匹配的关键词。

文案:
${text}`;
}

/**
 * 构造画面匹配的用户消息
 * @param paragraph 文案段落
 * @param availableScenes 可用画面描述列表
 * @returns 用户消息内容
 */
export function buildSceneMatchPrompt(paragraph: string, availableScenes: string[]): string {
  const scenes = availableScenes.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `文案段落:
${paragraph}

可用画面列表:
${scenes}

请挑选最匹配该段落的画面。`;
}
