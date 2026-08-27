/**
 * 语音克隆服务类型定义
 *
 * 职责:声明 GPT-SoVITS 集成相关的所有数据结构,包括:
 *   - 克隆音色(ClonedVoice):本地音色库的单条记录
 *   - 音色库元数据(VoiceLibraryMeta):音色库索引文件结构
 *   - 克隆样本参数(CloneSampleParams):创建新音色的入参
 *   - 克隆合成参数(CloneSynthParams):用克隆音色合成 TTS 的入参
 *   - 克隆合成结果(CloneSynthResult):合成产物描述
 *   - 服务状态(GptSoVitsStatus):GPT-SoVITS 子进程当前状态
 *   - 服务配置(GptSoVitsConfig):启动 GPT-SoVITS server 所需配置
 *
 * 设计约定:
 *   - 音色库存储在 userData/voice-library/ 目录,每个音色一条 JSON + 一份参考音频
 *   - 复用 tts 服务的 ChunkSynthesisResult / TextChunk / SrtEntry 类型
 *   - 与 src/shared/types.ts 中 'voice-clone-synthesize' 任务类型对齐
 */

/** 克隆音色支持的语言代码(与 GPT-SoVITS api_v2 保持一致) */
export type CloneLanguage = 'zh' | 'en' | 'jp' | 'kr' | 'auto';

/**
 * 克隆音色(本地音色库的一条记录)
 * 一个 ClonedVoice 对应一组参考音频 + 参考文本,GPT-SoVITS 据此克隆音色
 */
export interface ClonedVoice {
  /** 音色 ID(唯一,UUID 风格) */
  id: string;
  /** 音色名称(用户可读) */
  name: string;
  /** 原始样本文件路径(用户选择导入的文件) */
  samplePath: string;
  /** 音色库内的参考音频路径(复制后的副本,供 GPT-SoVITS 读取) */
  refAudioPath: string;
  /** 参考音频对应的参考文本(用于提示) */
  refText: string;
  /** 参考音频语言 */
  language: CloneLanguage;
  /** 创建时间(ISO 字符串) */
  createdAt: string;
}

/**
 * 音色库元数据(voice-library/index.json 结构)
 * 维护音色列表的轻量索引,避免每次扫描目录
 */
export interface VoiceLibraryMeta {
  /** 元数据版本号 */
  version: number;
  /** 所有音色记录 */
  voices: ClonedVoice[];
  /** 最后更新时间(ISO 字符串) */
  updatedAt: string;
}

/** 克隆样本参数(创建新音色的入参) */
export interface CloneSampleParams {
  /** 用户选择的样本文件路径(将被复制到音色库目录) */
  samplePath: string;
  /** 用户为该音色命名的名称 */
  sampleName: string;
  /** 样本对应的参考文本(GPT-SoVITS 用于对齐音色特征) */
  refText: string;
  /** 样本语言 */
  language: CloneLanguage;
}

/** 克隆合成参数(用克隆音色合成 TTS) */
export interface CloneSynthParams {
  /** 待合成文本(可长文本,内部会分片) */
  text: string;
  /** 目标音色 ID(音色库内的 voice.id) */
  voiceId: string;
  /** 输出 mp3 路径 */
  outputPath: string;
  /** 输出 srt 路径(可选,不传则不生成字幕) */
  srtPath?: string;
  /** 语速百分比(-100~100),GPT-SoVITS 通过 text_interval 实现 */
  rate?: number;
  /** 音量百分比(-100~100),通过后处理实现 */
  volume?: number;
}

/** 克隆合成结果 */
export interface CloneSynthResult {
  /** 最终生成的 mp3 文件路径 */
  audioPath: string;
  /** 当传入 srtPath 时,生成的 srt 文件路径 */
  srtPath?: string;
  /** 合成音频总时长(秒) */
  durationSec: number;
  /** 已合成字符数(用于校验是否截断) */
  charCount: number;
  /**
   * 是否降级到 Edge-TTS(016 AC5)
   * - true:GPT-SoVITS 服务未就绪或合成失败,自动降级到 Edge-TTS
   * - undefined/false:正常使用 GPT-SoVITS 克隆合成
   */
  fallback?: boolean;
  /** 降级原因(fallback=true 时填写,便于诊断) */
  fallbackReason?: string;
  /** 实际使用的 Edge-TTS 音色短名(fallback=true 时填写) */
  fallbackVoice?: string;
}

/**
 * GPT-SoVITS 服务状态机
 * not-installed:本机未检测到 GPT-SoVITS 安装
 * stopped:已安装但未启动
 * starting:子进程已 spawn,等待 HTTP 健康检查通过
 * running:服务可用,可接受合成请求
 * error:启动失败或运行中崩溃
 */
export type GptSoVitsStatus =
  | 'not-installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error';

/** GPT-SoVITS 服务配置(启动子进程所需) */
export interface GptSoVitsConfig {
  /** GPT-SoVITS 安装根目录(包含 api_v2.py);远程模式下可省略或填占位 */
  installPath: string;
  /** 监听端口,默认 9880 */
  port: number;
  /** 服务地址(host),留空/省略则使用本机 127.0.0.1;填写远程 IP/域名时连接云端 GPT-SoVITS */
  host?: string;
  /** GPT 模型路径(可选,通过 /set_model 切换) */
  modelPath?: string;
  /** SoVITS 模型路径(可选,通过 /set_model 切换) */
  sovitsModelPath?: string;
  /** Python 可执行文件路径(可选,默认从 PATH 查找 python) */
  pythonPath?: string;
}
