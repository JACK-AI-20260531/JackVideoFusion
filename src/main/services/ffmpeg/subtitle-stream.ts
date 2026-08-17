/**
 * 字幕流检测纯函数
 * 职责:从 ffprobe 原始返回结构中提取字幕流信息,供 probe 使用
 */
export interface SubtitleStreamInfo {
  /** 流索引 */
  index: number;
  /** 字幕编码器,如 mov_text / subrip */
  codec_name?: string;
  /** 语言标签 */
  language?: string;
}

/**
 * 判断一个流对象是否带 codec_type 且为字幕
 * @param stream ffprobe 流对象
 * @returns 是否为字幕流
 */
function isSubtitleStream(stream: unknown): stream is Record<string, unknown> {
  return (
    !!stream &&
    typeof stream === 'object' &&
    (stream as { codec_type?: unknown }).codec_type === 'subtitle'
  );
}

/**
 * 从 ffprobe 返回中提取全部字幕流
 * @param data ffprobe 返回(含 streams 数组)
 * @returns 字幕流元数据数组,无字幕流返回空数组
 */
export function extractSubtitleStreams(data: unknown): SubtitleStreamInfo[] {
  if (!data || typeof data !== 'object' || !('streams' in data)) {
    return [];
  }
  const streams = (data as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) {
    return [];
  }
  return streams
    .filter(isSubtitleStream)
    .map((stream) => {
      const language = stream.language;
      return {
        index: typeof stream.index === 'number' ? stream.index : -1,
        codec_name:
          typeof stream.codec_name === 'string' ? stream.codec_name : undefined,
        language: typeof language === 'string' ? language : undefined,
      };
    });
}
