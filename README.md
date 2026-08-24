# AI智剪工坊 (JackVideoFusion)

> Windows 桌面端 AI 批量视频混剪工具 · 本地优先 · 多平台自动发布

**AI智剪工坊** 是一款基于 Electron 的 Windows 桌面 AI 视频创作工具，面向短视频批量生产场景，提供从**素材处理、视频混剪、AI 剪辑、语音、字幕、到多平台自动发布**的一站式工作流。所有音视频处理在本地完成，不上传云端；AI 能力可离线运行（ONNX 本地推理）或按需联网（LLM / 微软 TTS / 平台发布）。

---

## 目录

- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [环境要求](#环境要求)
- [安装与运行](#安装与运行)
- [功能模块](#功能模块)
- [技术架构](#技术架构)
- [数据存储](#数据存储)
- [自动更新](#自动更新)
- [常见问题](#常见问题)
- [免责声明](#免责声明)
- [许可](#许可)

---

## 功能特性

### 8 大核心模块

| 模块 | 功能 | 是否需联网 |
|------|------|-----------|
| **素材处理** | 视频分割 / 文本分割 / 微软 TTS / 字幕提取 + OCR + 语音转写 | TTS 需联网 |
| **视频混剪** | 随机素材混剪 / 文件夹音频匹配混剪（支持断点续渲染） | 否 |
| **AI 剪辑** | 文案驱动 + LLM 关键词 + CLIP 语义匹配画面，自动切镜合成 | LLM 需联网 |
| **AI 切片剪辑** | 长视频镜头检测 + AI 精彩度评估，自动拆分成多条短视频 | 否 |
| **影视解说克隆** | 复刻参考视频的镜头节奏，替换画面 + 自定义配音字幕 | TTS 需联网 |
| **语音克隆** | GPT-SoVITS 音色克隆与合成（合成失败自动降级 Edge-TTS） | 否 |
| **自动发布** | 抖音 / 快手 / 小红书 / B站 / 微信视频号，批量 + 定时发布 | 是 |
| **系统设置** | 全局配置、参数模板、LLM 配置、自动更新 | 否 |

### 亮点能力

- 🎬 **真本地 AI**：CLIP 语义匹配、Whisper 语音转写均通过 ONNX 本地推理，不上传素材
- 🔀 **断点续渲染**：混剪任务支持暂停 / 恢复 / 取消，checkpoint 持久化，崩溃可恢复
- 📝 **多字幕方案**：内嵌字幕流提取、Tesseract OCR 画面识别、Whisper 语音识别人声
- 🗣️ **语音体系**：微软 Edge-TTS 配音 + GPT-SoVITS 音色克隆，生成 SRT 字幕
- 🚀 **自动化发布**：多平台账号管理，视频 × 平台自动生成任务，定时 / 立即发布
- 🔄 **自动更新**：应用内检查更新、下载、一键重启安装

---

## 界面预览

经典三栏布局：

```
┌─────────────┬──────────────────────────────────┐
│             │                                  │
│  侧边栏     │           主内容区               │
│  - 8 模块   │   (当前功能页的工作区)           │
│  - 任务面板 │                                  │
│  - 状态     │                                  │
│             │                                  │
├─────────────┴──────────────────────────────────┤
│                  (无底栏)                      │
└────────────────────────────────────────────────┘
```

- **侧边栏**：8 个功能模块入口、任务队列（实时进度）、本地模式状态
- **主内容区**：当前选中模块的工作界面

---

## 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 64 位及以上 |
| Node.js | 24.x（开发者环境） |
| 磁盘空间 | ≥ 2 GB（含 ffmpeg、onnxruntime、Whisper 等依赖与模型） |
| 内存 | ≥ 8 GB（AI 剪辑 / 语音克隆建议 16 GB） |
| 网络 | 微软 TTS、LLM、自动发布、首次模型下载需联网；本地剪辑离线可用 |

---

## 安装与运行

### 普通用户（安装包）

1. 从 [GitHub Releases](https://github.com/JACK-AI-20260531/JackVideoFusion/releases) 下载安装包
2. 双击 `AI智剪工坊-<版本>-x64.exe` 按向导安装
3. 从开始菜单或桌面快捷方式启动
4. 进入应用后可在「系统设置 → 关于」**检查更新**，一键升级到新版本

### 开发者（源码运行）

```bash
# 安装依赖
npm install

# 开发模式（完整 Electron 应用，推荐）
npm run dev:electron

# 纯浏览器 dev 环境（仅前端，IPC 不可用，部分功能受限）
npm run dev

# 类型检查
npm run typecheck

# 单元测试（node 内置 test runner + tsx）
npm test

# 生产构建
npm run build:electron

# 打包 Windows 安装包
npm run package:win
```

> **注意**：`npm run dev` 启动的纯浏览器环境下 IPC 不可用，部分按钮会提示「IPC 不可用：当前为浏览器 dev 环境」，属预期行为。完整功能请使用 `npm run dev:electron`。

---

## 功能模块

### 素材处理
- **素材分割**：按固定时长将单视频分割为多片段，支持命名模板、保留原画质、去原声
- **文本分割**：按字数切分长文本，批量导出 TXT
- **微软 TTS**：Edge-TTS 合成中文语音（6 种内置音色），可同步生成 SRT
- **字幕提取**：批量提取内嵌字幕流；无字幕流时可选择 **OCR 识别画面文字** 或 **语音识别人声**（Whisper）兜底生成 SRT

### 视频混剪
- **随机素材混剪**：多文件夹随机抽帧拼接，支持转场淡化（xfade 链式）、TTS 配音、字幕、水印
- **文件夹音频匹配**：每文件夹用对应音频配视频合成，背景音乐淡入淡出
- 均支持**暂停 / 恢复 / 断点续渲染**

### AI 剪辑
输入解说文案 → LLM 抽取关键词 → CLIP 语义匹配画面对应片段 → 自动切镜合成成片。可配置 TTS 配音、字幕烧录、水印。

### AI 切片剪辑
长视频 → 镜头检测 → AI 精彩度评估 → 自动拆分为多条独立短视频。

### 影视解说克隆
复刻参考解说视频的镜头节奏，用自有素材替换画面，配合自定义 TTS 配音与字幕，生成全新原创解说视频。

### 语音克隆
基于 GPT-SoVITS 的音色克隆与合成；服务未就绪或合成失败时自动降级到 Edge-TTS。

### 自动发布
多平台（抖音 / 快手 / 小红书 / B站 / 微信视频号）账号登录、视频批量 + 定时发布，支持发布队列管理（暂停 / 取消 / 清理）。

### 系统设置
默认分辨率、导出目录、水印 / 字幕样式、任务并发、LLM 配置、参数模板、音色库管理、**自动更新**。

---

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│  Renderer (Vue 3 + Pinia + Vue Router)              │
│  · 8 模块视图 · 任务面板 · 日志面板 · 设置          │
└──────────────────────┬──────────────────────────────┘
                       │ contextBridge (window.api)
                       │ invoke / on / send (IPC)
┌──────────────────────▼──────────────────────────────┐
│  Main (Electron)                                     │
│  · preload.ts 安全桥接                               │
│  · IPC 服务层 (src/main/ipc/)                        │
│  · 服务层 (src/main/services/)                       │
└──────────────────────┬──────────────────────────────┘
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
    FFmpeg        任务队列        AI 能力          平台发布
  (fluent-ffmpeg) (并发/持久化)  · CN-CLIP ONNX    (Playwright)
                                · Whisper ONNX     抖音/快手/
                                · Tesseract OCR    小红书/B站/视频号
                                · LLM providers
                                · Edge-TTS
                                · GPT-SoVITS
```

### 关键技术栈

| 分类 | 技术 |
|------|------|
| 桌面框架 | Electron 32 + electron-builder（NSIS 安装包） |
| 前端 | Vue 3 (Composition API) + Pinia + Vue Router + Vite + Less |
| 语言 | TypeScript（strict 模式） |
| 媒体处理 | fluent-ffmpeg（探测 / 分割 / 拼接 / 抽帧 / 转场 / 字幕 / 水印） |
| 本地 AI | onnxruntime-node（CN-CLIP、Whisper）、tesseract.js（OCR WASM） |
| 语音 | msedge-tts（微软 Edge-TTS）、GPT-SoVITS（HTTP 客户端） |
| 浏览器自动化 | playwright-core（多平台发布） |
| 任务系统 | 自研 task-queue（并发控制、checkpoint 持久化、进度推送） |
| 日志 | winston + daily-rotate-file + 渲染层实时广播 |
| 存储 | electron-store（配置 / 任务记录 / 工程文件持久化） |
| 自动更新 | electron-updater（Gitee / GitHub Releases generic 源） |

### 目录结构

```
JackVideoFusion/
├── electron/               # Electron 主进程入口、preload、IPC 注册中心
│   ├── main.ts             # 窗口创建、菜单、生命周期
│   ├── preload.ts          # contextBridge 安全桥接 (window.api)
│   ├── bootstrap.ts        # 主进程引导（@main 别名注册）
│   └── ipc/                # IPC 自动注册中心
├── src/
│   ├── main/               # 主进程侧
│   │   ├── ipc/            # 各服务 IPC 注册（config/ffmpeg/tts/asr/clip...）
│   │   ├── services/       # 核心服务
│   │   │   ├── ffmpeg/     # FFmpeg 封装
│   │   │   ├── asr/        # Whisper 语音转写
│   │   │   ├── ocr/        # Tesseract 画面文字识别
│   │   │   ├── clip/       # CN-CLIP 语义匹配
│   │   │   ├── ai-edit/    # AI 剪辑
│   │   │   ├── ai-slice/   # AI 切片
│   │   │   ├── video-mix/  # 视频混剪
│   │   │   ├── auto-publish/ # 多平台发布
│   │   │   ├── voice-clone/  # 语音克隆
│   │   │   ├── tts/        # 微软 TTS
│   │   │   ├── task-queue/ # 任务队列
│   │   │   └── updater/    # 自动更新
│   │   └── utils/          # 日志等工具
│   ├── renderer/           # 渲染层（Vue 3）
│   │   ├── views/          # 8 大模块视图
│   │   ├── stores/         # Pinia 状态
│   │   ├── components/     # 公共组件
│   │   └── utils/
│   └── shared/             # 主进程 / 渲染层共享类型
├── docs/                   # 文档（操作手册等）
├── scripts/                # 构建 / 修复脚本
├── models/                 # 本地模型（CLIP 等）
└── ocr-data/               # OCR 语言包本地缓存
```

---

## 数据存储

所有配置、任务记录、模型与缓存存于系统 `userData` 目录：

```
Windows: C:\Users\<用户名>\AppData\Roaming\AI智剪工坊\
├── config\    # 全局配置、参数模板
├── data\      # 任务记录
├── projects\  # 工程文件
├── ocr-data\  # OCR 语言包
├── models\    # 本地 AI 模型（CLIP / Whisper）
└── logs\      # 运行日志（按日切割）
```

---

## 自动更新

- 打包安装版可在「系统设置 → 关于」点击**检查更新**，发现新版本后点「下载更新」，完成后点「重启安装」一键升级
- 更新源为 Gitee / GitHub 的 Releases（generic provider），依赖 electron-updater 生成 `latest.yml`
- 开发者 `npm run dev:electron` 环境不支持自动更新（预期行为）；请使用打包安装版测试

---

## 常见问题

- **AI 剪辑顶部显示黄色警告？** 需先在「系统设置 → LLM 配置」填写 Provider / 接口地址 / API Key（ollama 可留空）/ 模型名。
- **字幕提取显示"跳过"？** 视频无内嵌字幕流。可在「无字幕流时」选择 **OCR 识别画面文字**（适合烧录硬字幕）或 **语音识别人声**（适合解说 / 旁白）。
- **语音识别第一次很慢 / 要联网？** 首次使用需下载 Whisper 模型到本机 `userData\models\asr\`，之后离线可用。
- **微软 TTS 合成失败？** 检查网络；文本勿超 5 万字（超限自动截断）；重新选择音色。
- **自动发布提示账号过期？** 平台 Cookie 有过期时间，重新扫码登录，避免频繁发布。
- **更多问题与细节**：参见 [docs/操作手册.md](docs/操作手册.md)。

---

## 免责声明

本工具仅为视频剪辑辅助工具，用户需自行保证素材版权合法，禁止用于侵权、搬运、违规内容创作。自动发布需遵守各平台规则，因违规操作产生的后果由用户自行承担。遵循微软 TTS 开源协议，不剥离、不单独售卖语音能力。

---

## 许可

本项目基于 [MIT License](LICENSE) 开源。

---

*项目仓库：Gitee [jackgoogle/JackVideoFusion](https://gitee.com/jackgoogle/JackVideoFusion) · GitHub [JACK-AI-20260531/JackVideoFusion](https://github.com/JACK-AI-20260531/JackVideoFusion)*
