# AGENTS.md — AI 协作开发规范

> 本文件是 AI 编码代理( opencode / Claude / Codex 等)在本仓库工作的**强制上下文**。
> 目标:任何代理在冷启动会话中,不靠口口相传也能正确构建、测试、发布本项目。

## 1. 项目概览

**AI智剪工坊(JackVideoFusion)** — Windows 桌面端 AI 批量视频混剪工具。

- 技术栈:Electron 32 + Vue 3 + TypeScript,ffmpeg + ONNX(CN-CLIP/Whisper)
- 核心链路:素材处理 → 视频混剪/AI混剪 → TTS/声音克隆 → 字幕 → 多平台自动发布
- 双包结构:`src/main`(主进程服务)+ `src/renderer`(Vue 界面)+ `electron/`(bootstrap/IPC 注册)+ `src/shared`(共享类型)

## 2. 命令与验证门禁

| 命令 | 用途 |
|------|------|
| `npm run dev:electron` | 开发运行(推荐);`npm run dev` 仅前端,IPC 模拟 |
| `npm test` | 全量单测(node --test + tsx),当前 880 用例,**必须全绿** |
| `npm run typecheck` | vue-tsc(渲染层) |
| `npx tsc -p tsconfig.electron.json --noEmit` | 主进程 tsc,**比 vue-tsc 更严格,必须单独跑** |
| `npm run package:win` | 打包 NSIS 安装包到 `release/` |

**完成任何改动的门禁:`npm test` + `npm run typecheck` + `npx tsc -p tsconfig.electron.json --noEmit` 三者全过。**
(教训:vue-tsc 通过但 electron tsc 报错导致打包失败过,两者覆盖的严格度不同。)

## 3. 架构地图

```
src/main/services/        # 业务服务(每目录一个领域)
  ai-slice/               #   AI切片:score.ts纯函数 / analyzer / virality.ts(LLM评分) / virality-service.ts(编排)
  auto-publish/           #   自动发布:publish-queue(串行链) / schedule-store(持久化定时) / adapters(平台适配器)
  task-queue/             #   任务队列:状态机+checkpoint(断点续渲),持久化 userData/task-queue/tasks.json
  llm/                    #   LLM:provider(openai/ollama)+ prompts;chat() 自动读配置
  text-timeline/          #   文本即时间线:v2.0;transcript/edl/command-stack 纯函数 + service(会话) + exporter(EDL→成片) + edit-plan(对话式改片)
  mix-template/           #   混剪参数模板:v2.1;template-store(load/persist 注入,落 userData/mix-templates)
  pipeline/               #   自动流水线:v2.1;validate 纯函数 / runner(串行编排+产物链) / scheduler(定时轮询) / store(落 userData/pipelines)
  semantic/               #   素材语义化:v2.1;similarity 纯函数 / indexer(CN-CLIP 建库+zero-shot 标签) / search(自然语言 Top-K) / index-store(落 userData/semantic)
  matrix/                 #   矩阵运营:v2.1;group-store(平台分组) / aggregateByGroup(分组聚合) / suggestGroups(内容-分组建议)
  asr / ocr / clip / shot-detect / tts / voice-clone / film-dub-clone / video-mix / material-* / ffmpeg / storage / config-service / updater
src/main/ipc/             # IPC 注册(ai-slice.ipc.ts 等),经 safeHandle 包装
electron/ipc/index.ts     # registerAllIpc():**新 IPC 模块必须在此注册,否则运行时不存在**
src/renderer/views/       # 11 个页面视图(Vue3 setup)
docs/                     # 操作手册 / 全流程指南 / PRD(产品需求按版本号存档)
```

## 4. 强制约定(与现有代码不一致会被拒绝)

1. **纯函数与编排分离**:业务逻辑写成不依赖 electron 的纯函数(可 node:test 单测),electron I/O 用**依赖注入**绕开(参考 `task-queue.ts` 的 `TaskQueueDeps`、`schedule-store.ts` 的 `load/persist` 注入)。
2. **测试风格**:node:test + `assert/strict`,文件放 `__tests__/*.spec.ts`,import 带 `.ts` 后缀;新功能必须带单测。
3. **注释**:中文 JSDoc,文件头写"职责/设计要点",关键算法写明公式与权重。
4. **IPC 模式**:`safeHandle(ipc, 'channel', handler)`;入参逐字段校验(参考 `ai-slice:scoreVirality`);渲染层经 `window.api.invoke(channel, payload)` 调用,返回 `{ok, data, error}`。
5. **持久化**:JSON 文件落 userData(如 `schedule.json`),每次变更即写盘;状态机必须有合法流转表并拒绝非法流转。
6. **LLM 调用**:温度 ≤0.3,只输出 JSON 并做容错解析(剥离 markdown 围栏 → 整段直解 → 截取数组/对象),缺失字段降级不抛错(参考 `ai-slice/virality.ts`)。
7. **IPC 传参**:禁止直传 Vue 响应式对象,需 `JSON.parse(JSON.stringify())` 深拷贝,否则 "An object could not be cloned"。
8. **纯函数阈值/权重**:集中常量并导出(如 `GRADE_S_MIN`),不写魔法数字。

## 5. 已踩过的坑(勿重蹈)

- **ModelScope 下载 403**:CDN 拒无 User-Agent 请求;下载需带 Chrome UA + 跟随 302(见 `clip/model-downloader.ts`)。
- **electron-updater 是 CJS**:取 `mod.default.autoUpdater`,不要动态 import 探测命名导出。
- **dialog:openDirectory** 返回 `{path}` 对象,不是字符串。
- **任何 JSON 禁止 PowerShell `Set-Content -Encoding UTF8`**:会写 BOM 导致 JSON 解析失败(package.json/package-lock.json 均踩过);统一用 .NET API:`[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`。
- **package-lock.json 禁止全文件正则替换版本号**:会误伤依赖 semver 区间与依赖版本(踩过 87 行误改);只改前 10 行内的根节点 `"version"`(共 2 处),逐行匹配。
- **`git add -A` 前先确认本地 AI 模型缓存**:Whisper 等模型可能下载到工作目录 `models/`(~500MB,已 gitignore),提交前检查 `git status` 不含 models/。
- **目录名/产品名含中文**会导致 exe 乱码:`build.win.executableName` 固定为 ASCII `JackVideoFusion`。
- **版本号硬编码 8 处**:package.json + package-lock.json 根节点(2 处:version + packages."".version,注意依赖自己的版本号不能动)+ `electron/main.ts` + `App.vue` + `SettingsView.vue` + `Sidebar.vue` + 两份 docs,发版必须全部同步。
- **多行命令 `\` 续行在 PowerShell 不可用**;gh release 用 `--notes-file` 传说明。

## 6. 发布清单(Release Checklist)

1. 同步版本号 8 处(见上,含 package-lock 根节点);
2. 门禁三连:`npm test` / `npm run typecheck` / `npx tsc -p tsconfig.electron.json --noEmit`;
3. `npm run package:win`;确认 `release/` 生成 exe + blockmap + latest.yml(version 字段正确);
4. 启动 `release\win-unpacked\JackVideoFusion.exe` 冒烟:日志确认 IPC 通道数、CLIP 引擎、无 Mock 降级;
5. 提交推送双远端(`github` + `gitee`,两套都要推),打 tag `vX.Y.Z`;
6. `gh release create vX.Y.Z <exe> <blockmap> <latest.yml> --title "AI智剪工坊 vX.Y.Z" --notes-file <文件>`;
7. 验证 Release 资产 `state: uploaded` 且被标记 Latest。

## 7. 文档索引

- `docs/操作手册.md` — 用户手册(功能/Q&A/故障排查)
- `docs/全流程操作指南.md` — 6 条管线(A-F)+ 文本精剪精修步骤
- `docs/PRD-*.md` — 按版本存档的产品需求(v1.5/v1.6/v2.0 文本时间线)
- 日志位置:`%APPDATA%/jack-video-fusion/logs/`(诊断打包版问题先看这里)
