# PRD:发布闭环与素材兜底(v1.6)

| 项目 | 内容 |
|------|------|
| 版本 | v1.0 |
| 目标版本 | JackVideoFusion v1.6.x |
| 状态 | 待评审 |
| 关联模块 | `auto-publish` / `material-repo` / `clip` / `ai-edit` / `video-mix` / `task-queue` / `ffmpeg` / `AutoPublishView` / `AIEditView` |

---

## 0. 背景与定位

v1.5 完成了"评分 → 标题/标签 → 定时/错峰分发"的生成侧闭环。竞品调研的结论是:**AI 成片已免费化,数据与效率才是付费点**。v1.6 补齐三块短板:

1. **发布后无数据**:视频发出去就"失联",爆款评分没有实际表现对照;
2. **封面只有文案没有图**:封面图仍需用户手工截图/制作;
3. **批量生产依赖手工**:多任务仍需逐个配置;CLIP 匹配不到贴题素材时成片质量下降,无兜底。

---

## 1. 目标与非目标

### 目标
1. **发布数据回收**:发布成功的任务可查询播放/点赞/评论数,与爆款评分同屏对照;
2. **智能封面**:基于高光帧 + v1.5 封面文案自动生成封面图(无需外部 API);
3. **批量任务清单**:CSV 一次导入 N 个发布任务,失败隔离、逐条校验、批量入队;
4. **AI 素材兜底**:CLIP 匹配置信度不足时自动降级到素材库全量检索 → 可选外部免版权图库。

### 非目标
- 不做自动数据轮询(平台风控风险,仅提供手动"刷新数据");
- 不做 AI 生图(留待评估供应商后再立项);
- 不做多账号池(当前 auth-store 为单账号/平台,矩阵多账号待平台风控策略明朗后立项)。

---

## 2. 用户故事

| # | 故事 | 验收点 |
|---|------|--------|
| U1 | 我发布了一周的视频,想看哪条表现最好 | 定时任务面板点「刷新数据」,显示播放/点赞数并与爆款分并排 |
| U2 | 我不想手动做封面 | 发布表单勾选「自动生成封面」,成片高光帧 + 封面文案自动出图 |
| U3 | 我有 20 条视频要发布到 3 个平台 | 导入一份 CSV,60 条任务一次入队,校验失败的行单独提示不影响其余 |
| U4 | CLIP 匹配不到"量子力学"相关画面 | 自动放宽到素材库全量检索并在日志标注"兜底命中",成片不断档 |

---

## 3. 功能需求

### FR-1 发布数据回收(P0)

- **触发**:发布队列中 `completed` 且有 `videoUrl` 的任务,卡片出现「刷新数据」;**手动触发**,不自动轮询;
- **采集方式**:复用 `browser-manager` 打开已登录会话访问视频页,按平台适配器新增 `fetchStats(url)`(各平台选择器独立维护,失败静默标记"暂不可用");
- **数据项**:播放数、点赞数、评论数、采集时间(平台可见什么采什么,允许部分缺失);
- **存储**:新增 `analytics-store`(沿用 schedule-store 的注入式 JSON 持久化,`userData/auto-publish/analytics.json`),按 `videoUrl` 去重,保留**历次采集时间线**(至少最近 30 条);
- **展示**:任务卡片与数据面板并排显示"爆款分 vs 实际播放",排序开关"按播放数"。

### FR-2 智能封面生成(P0)

- **触发**:发布表单新增「自动生成封面」勾选(默认开);对每个待发布视频生成 `cover-<视频名>.jpg` 并填入 `coverPath`;
- **抽帧策略**:优先用 AI 切片的最高分镜头中间帧(有切片结果时);无切片结果则按视频 25%/50%/75% 三处抽帧,由 LLM(已配置时)选择与标题最相关的一帧,未配置 LLM 时取中间帧;
- **文字叠加**:ffmpeg `drawtext` 把 v1.5 生成的封面文案(取第一条,超 16 字截断)渲染到画面下方安全区,白字黑边,字号按分辨率自适应;
- **产物**:封面图写入导出目录,发布表单可预览、可手动替换。

### FR-3 批量任务清单(P0)

- **入口**:自动发布页新增「导入清单」按钮,接受 `.csv`(UTF-8,带表头);
- **列定义**:`videoPath, platform, title, description, tags(分号分隔), coverPath, scheduledAt(ISO 或 yyyy-MM-dd HH:mm)`;
- **校验**(逐行,失败隔离):平台合法、文件存在、标题非空、时间可解析;校验失败的行汇总提示(行号+原因),合法行继续入队;
- **入队**:合法行转 `PublishParams[]` 走现有 `batchPublish`(支持 `staggerIntervalMs` 错峰);
- **模板**:提供「下载模板」导出表头 + 2 行示例。

### FR-4 AI 素材兜底(P1)

- **触发点**:AI 混剪管线的 CLIP 画面匹配阶段;当某段落最高匹配置信度 < `clipFallbackThreshold`(新配置项,默认 0.35)时触发;
- **兜底顺序**:
  1. **全量素材库检索**:把候选范围从"关键词命中集"放宽到 `material-repo` 全库重新排序,取最高分;
  2. **过渡画面**:仍不足时使用该段落前置画面的延长帧(帧冻结)或预设过渡卡(带段落关键词文字),保证成片不断档;
- **可解释**:日志与成片报告标注"第 N 段使用兜底素材(原因:匹配不足)",沿用 v1.5 的可解释性原则;
- **外部图库(预留)**:`PexelsProvider` 接口占位,API Key 配置项预留,本期不实现请求逻辑。

---

## 4. 交互设计

### 4.1 发布队列卡片
```
┌────────────────────────────────────────────┐
│ [抖音] 标题xxx        ✅已完成              │
│ 🔥爆款分 88(S)   ▶播放 12.3k 👍 456 💬 89   │
│ 🕒 采集于 09-07 14:20      [刷新数据]        │
└────────────────────────────────────────────┘
```

### 4.2 导入清单弹窗
- 拖拽/选择 CSV → 预览表格(前 10 行)→ 校验结果红绿标注 → 「导入合法行」;
- 汇总:`共 22 行,合法 20,失败 2(第 7 行:平台不支持;第 13 行:文件不存在)`。

---

## 5. 技术方案

### 5.1 数据结构
```ts
// analytics-store.ts
interface VideoStats {
  videoUrl: string;
  taskId: string;
  plays?: number;
  likes?: number;
  comments?: number;
  collectedAt: string; // ISO
}
interface AnalyticsRecord {
  videoUrl: string;
  taskId: string;
  platform: PublishPlatform;
  history: VideoStats[]; // 最近 30 条
}
```

### 5.2 模块与调用链
1. `auto-publish/analytics-store.ts`(新):`AnalyticsStore` 类,注入式 load/persist(照抄 ScheduleStore 模式);纯函数 `parseStatsFromPage(platform, html/domText)` 便于单测;
2. `adapters/base-adapter.ts`:新增可选方法 `fetchStats(url: string): Promise<VideoStats>`;五个平台适配器各自实现,选择器集中为常量表;
3. `auto-publish/cover.ts`(新):`pickHighlightFrame(clipInfo | videoPath, ffmpegService)` + `renderCover(framePath, coverText, outPath, ffmpegService)`,ffmpeg 命令走现有 `ffmpeg` 服务;纯函数 `pickCoverText(virality)` 可单测;
4. `auto-publish/import-csv.ts`(新):`parseCsv(text): { rows, errors }` 纯函数(自实现 CSV 解析:处理引号转义/换行,不引第三方库);`buildCsvTemplate(): string`;
5. `ai-edit` 管线:`matchShots` 返回后增加 `applyFallback(stage, threshold)` 阶段;`config` 新增 `clipFallbackThreshold?: number`;
6. IPC:`auto-publish:fetchStats` / `auto-publish:importCsv`(校验+入队)/ `auto-publish:generateCover`;`ai-edit` 配置项随 config 通道透出。

### 5.3 测试要求
- `parseStatsFromPage`(各平台页面片段 fixture)、`parseCsv`(引号/BOM/空行/中文)、`pickCoverText`、`staggerTimes` 回归、兜底阈值判定纯函数全覆盖;
- 适配器 `fetchStats` 以注入 HTML 字符串方式测选择器逻辑,不做真实网络请求。

---

## 6. 成功指标

| 指标 | 目标 |
|------|------|
| 发布任务数据回收使用率 | ≥ 50% |
| 自动封面采用率(未手动替换) | ≥ 60% |
| CSV 批量导入渗透(≥5 行的任务占比) | ≥ 30% |
| 兜底触发的成片断档率 | 0 |

## 7. 风险与依赖

| 风险 | 对策 |
|------|------|
| 平台页面改版导致数据采集失败 | 采集失败静默降级 + 提示"暂不可用";选择器集中常量表便于热修 |
| 浏览器采集触发风控 | 仅手动触发;复用已登录会话;单次单任务,无批量轮询 |
| ffmpeg drawtext 中文字体依赖 | 打包内置思源黑体子集字体;字体缺失时降级为无文字纯帧封面 |
| CSV 编码乱码 | 按 BOM 检测 UTF-8/GBK 双解码 |
| 兜底画面体验下降 | 阈值默认保守(0.35);成片报告透明标注;可配置关闭 |

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 | analytics-store + fetchStats(抖音先行)+ IPC + 面板展示 | U1 通过 |
| M2 | 智能封面(抽帧+文字叠加)+ 表单集成 | U2 通过 |
| M3 | CSV 导入(解析/校验/入队)+ 模板 | U3 通过 |
| M4 | AI 素材兜底(阈值放宽 + 过渡卡)+ 成片报告标注 | U4 通过 |
