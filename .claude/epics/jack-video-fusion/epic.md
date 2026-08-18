---
name: jack-video-fusion
status: backlog
created: 2026-07-30T10:36:07Z
updated: 2026-07-30T10:36:07Z
progress: 0%
prd: .claude/prds/jack-video-fusion.md
github: (will be set on sync)
---

# Epic: jack-video-fusion(AI智剪工坊)

## Overview
基于 PRD 构建 Windows 桌面端 AI 批量视频混剪工具。整体架构以 Electron + Vue3 为主框架,FFmpeg 为音视频处理中枢,Edge-TTS 提供完全免费的配音能力,ONNX Runtime + CLIP 提供本地离线画面匹配,可选 LLM 提供语义增强。V1.0 交付可用基础版,V1.1 引入 AI 增强,V1.2 完成语音克隆与自动发布。代码层强制"文件夹隔离"规则,保障素材匹配语义一致。

## Architecture Decisions
- **渲染层 / 主进程分离**:Vue3 + Pinia 渲染 UI;Electron Main 进程负责文件系统、FFmpeg 进程编排、Edge-TTS 调用、CLIP 推理、任务队列持久化。
- **任务队列**:SQLite 持久化任务状态,支持暂停 / 终止 / 断点续渲染。
- **FFmpeg 封装**:统一 IPC 服务 `ffmpeg-service`,所有混剪 / 分割 / 合成 / 水印 / 字幕 / 转码都走该服务,避免散落 `exec`。
- **TTS 编排**:`tts-service` 内部用 Edge-TTS Node SDK,**流式接收音频 + 按 SRT 时间轴切片落盘**,保证 5W 字符无截断。
- **本地 AI**:`clip-service`(ONNX Runtime)加载 CLIP-ViT-B/32,接收文本与帧向量相似度计算,纯离线。
- **LLM 增强**:`llm-service` 抽象 Provider 接口(OpenAI / 通义千问 / Ollama),统一鉴权 + 提示词模板 + 关键词抽取。
- **文件夹隔离**:在素材仓库层(`material-repo`)以 `(folderId, fileId)` 为作用域,匹配算法只接受同 `folderId` 资源,**任何跨文件夹调用需显式走白名单**。
- **配置 / 模板**:JSON 形式保存参数默认值与工程文件,存放在 `userData/config`。
- **合规植入**:启动页 + About 弹窗固定免责声明;UI 文案审查 pipeline 拦截"去重 / 规避查重 / 搬运"等违规词。

## Technical Approach

### Frontend Components
- 全局布局:`AppLayout`(左侧固定导航 + 右侧主功能区 + 底部日志栏,深色主题)
- 路由:`vue-router` 注册 `material-process / video-mix / ai-edit / ai-slice / film-dub-clone / auto-publish / settings`
- 通用组件:`FolderPicker / DragDropZone / LogPanel / ProgressBar / ParamForm / TaskQueueList / WatermarkEditor / SubtitleEditor`
- 状态:Pinia 拆分 `useMaterialStore / useTaskStore / useLogStore / useConfigStore`

### Backend Services(Electron Main + 独立进程)
- `ffmpeg-service`:分割 / 抽帧 / 拼接 / 转码 / 滤镜 / 水印 / 字幕烧录
- `tts-service`:Edge-TTS 调用 + 长文本分片 + SRT 生成
- `subtitle-service`:内嵌字幕提取(基于 FFmpeg stream + OCR fallback)
- `clip-service`:ONNX Runtime 推理,文本/图像嵌入向量,余弦相似度匹配
- `llm-service`:Provider 抽象,统一鉴权/重试/超时/关键词输出
- `shot-service`:PySceneDetect 镜头节点解析(V1.1 启动)
- `task-queue`:SQLite 持久化,状态机 `pending → running → paused → completed/failed`,支持 checkpoint
- `material-repo`:文件夹隔离作用域管理
- `config-service`:参数模板 / 工程文件读写

### Infrastructure
- 打包:electron-builder,Windows x64 NSIS 安装包
- 本地模型:CLIP 模型权重随包分发(可后续改为首次启动下载)
- Python 子进程:PySceneDetect 通过 `python-shell` 调用
- 日志:winston + 日志文件按日切割

## Implementation Strategy
1. **基础骨架(优先 V1.0)**:Electron+Vue3 工程、布局、路由、Pinia、IPC 骨架、SQLite、FFmpeg 服务壳
2. **素材处理(优先 V1.0)**:素材分割、文本分割、字幕提取、Edge-TTS(含 5W 字符长文本)
3. **视频混剪双模式(优先 V1.0)**:随机混剪 + 文件夹音频匹配,文件隔离规则在 service 层固化
4. **通用能力(优先 V1.0)**:水印、字幕、分辨率、任务队列、日志、断点续渲染
5. **AI 剪辑(优先 V1.1)**:CLIP 本地匹配 + LLM 增强 Provider
6. **AI 切片 + 影视解说克隆(优先 V1.1)**
7. **语音克隆(优先 V1.2)**
8. **多平台自动发布(优先 V1.2)**

## Task Breakdown Preview
详细任务见 `001.md` 起。V1.0 任务清单(预估 7-9 个),V1.1/V1.2 任务将作为后续 Epic 增量追加。

## Dependencies
- Node.js ≥ 18,Electron ≥ 28,Vue3 ≥ 3.4
- FFmpeg(随包或系统 PATH)
- `onnxruntime-node` + CLIP 模型权重
- `edge-tts`(Node SDK)
- `python-shell` + 本地 Python 3.10+(PySceneDetect)
- `better-sqlite3`(任务持久化)
- `electron-builder`(打包)

## Success Criteria (Technical)
- V1.0:9 个核心功能全部端到端跑通,验收标准全部满足
- 5W 字符 TTS 一次合成,无截断 / 无乱码,合成时间 < 单倍音频时长 × 2
- 文件夹隔离规则在 `material-repo` 单元测试覆盖率 ≥ 95%
- 任务队列可承载 50+ 任务排队,断点续渲染准确恢复
- 应用在 Windows 10/11 x64 启动 < 5s,主功能切换 < 500ms
- 本地 AI 模式 0 网络请求(可通过 DevTools Network 面板验收)

## Estimated Effort
V1.0 预估 80-120 人时(单人)。V1.1 预估 60-80 人时。V1.2 预估 40-60 人时。

## Tasks Created

### V1.0 基础可用版(已完成 ✅)
- [x] 001.md - 项目骨架与全局布局(并行: true)
- [x] 002.md - 持久化与配置服务(SQLite + JSON 配置)(并行: true,依赖 001)
- [x] 003.md - FFmpeg IPC 服务封装(并行: true,依赖 001)
- [x] 004.md - 素材仓库与文件夹隔离机制(并行: true,依赖 002)
- [x] 005.md - 任务队列(排队/暂停/终止/断点续)(并行: true,依赖 002)
- [x] 006.md - 微软 Edge-TTS 服务与 SRT 生成(并行: true,依赖 003)
- [x] 007.md - 素材处理模块 UI + 服务(分割/文本分割/字幕提取)(并行: true,依赖 003,004)
- [x] 008.md - 视频混剪双模式(随机混剪 + 文件夹音频匹配)(并行: false,依赖 003,004,005,007)
- [x] 009.md - 通用能力(水印/字幕/分辨率/日志面板)(并行: true,依赖 001,003)

### V1.1 AI 增强版(已完成 ✅)
- [x] 010.md - LLM Provider 抽象(OpenAI/通义千问/Ollama)
- [x] 011.md - CLIP 本地推理(ONNX Runtime)
- [x] 012.md - 镜头检测(shot-detect)
- [x] 013.md - AI 剪辑(文案驱动 + CLIP 匹配)
- [x] 014.md - AI 切片(精彩度分析 + 批量输出)
- [x] 015.md - 影视解说克隆(节奏复刻 + 素材替换)

### V1.2 商业化完整版(已完成 ✅)
- [x] 016.md - 语音克隆服务(GPT-SoVITS 集成)(并行: true,依赖 006,007)
- [x] 017.md - 多平台自动发布(Playwright 浏览器自动化)(并行: true,依赖 005,009)

Total tasks: 17
V1.0 effort: 约 90-130 人时(已完成)
V1.1 effort: 约 60-80 人时(已完成)
V1.2 effort: 约 44-60 人时(已完成)
