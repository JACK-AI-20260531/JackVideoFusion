# PRD v2.2 — 发布文案 AI 助手

> 版本:v2.2.0
> 日期:2026-09-02
> 状态:已评审通过(B → A 两里程碑,A 为 v2.2 后续/或顺延 v2.3)

## 1. 背景与目标

发布前文案(标题/描述/话题)全靠手写,存在三个痛点:

1. **单条成本高**:好标题需要反复琢磨,每条视频 3-5 分钟;
2. **平台风格错配**:同一文案发抖音/B站/小红书,调性不匹配影响推荐;
3. **矩阵批量低效**:多平台发布时文案差异化依赖人工改写。

目标:发布表单一键生成平台风格文案(3 候选标题 + 描述 + 话题标签),
复用既有 `llmService.chat` 通道,把"写文案"从分钟级压到秒级。

与 v2.1-M3 推荐分组同属"发布前"环节,UI 就近联动(建议分组 → 生成该平台风格文案)。

## FR-1 文案生成服务(`src/main/services/copywriting/`)

### FR-1.1 平台风格常量表 `PLATFORM_STYLE`

以 `PublishPlatform` 五平台为键,每平台包含:

| 字段 | 说明 |
|------|------|
| `label` | 平台中文名 |
| `styleHint` | 风格要点(喂给 LLM,如抖音=强钩子口语化前 3 秒抓人、B站=信息量+分区调性、小红书=种草体+emoji、快手=真实接地气、视频号=温和大众向) |
| `titleRange` | 标题字数建议(如抖音 10-20,B站 15-30) |
| `tagCount` | 话题标签建议数量区间 |

风格文案集中一处维护,新增平台只加常量,不改逻辑。

### FR-1.2 纯函数(不依赖 electron/llm)

- `buildCopyPrompt(title: string, platform: PublishPlatform): ChatMessage[]`
  system 提示词:角色设定(短视频运营专家)+ JSON-only 输出约束
  (字段 titles[3]/description/tags,无 markdown 围栏)+ 温度声明;
  user 消息:原始标题/主题 + 平台风格要点。
- `parseCopyResponse(raw: string): Copywriting | null`
  容错解析:剥离 markdown 围栏 → 整段直解 → 截取首个 `{...}` 对象;
  缺字段降级(titles<1 或全空 → null,由服务层抛中文错误);
  tags 归一化:去 `#`、去空、去重、截断 8 个。

### FR-1.3 编排 `generateCopywriting(title, platform, deps)`

- deps 注入 `chat`(默认 `llmService.chat`),温度 0.3,maxTokens 600;
- 未配置 LLM(provider 为空或 testConnection 失败)→ 返回
  `{ ok: false, error: '请先在系统设置中配置 LLM 服务' }`,不抛错;
- 解析失败 → 中文错误提示,附原始输出前 100 字符便于诊断。

## FR-2 IPC 通道

`copywriting:generate { title, platform }`
→ `{ ok, data: { titles: string[], description: string, tags: string[] } | error }`

入参逐字段校验(safeHandle 模式):title 非空且 ≤100 字;platform ∈ 五平台白名单。

## FR-3 发布表单 UI(AutoPublishView)

1. 标题输入行尾部加 **✨ AI 文案** 按钮:
   - 点击 → 按当前标题(可为关键词/草稿)+ 目标平台生成;
   - 目标平台:按钮旁小下拉,默认取第一个已勾选发布平台;
   - 未勾选平台时用「抖音」风格并在结果面板标注。
2. 生成结果内联面板(表单下方):
   - 3 个候选标题,点击即填入标题框;
   - 描述「填入」按钮;话题标签点击填入(逗号拼接);
   - 面板头部显示所用平台与来源(LLM/失败原因)。
3. 未配置 LLM:点击时展示设置引导提示,不报错弹窗。
4. 生成中按钮 loading、防重复点击。

## 非目标(本期不做)

- 多平台批量差异化文案(逐平台循环生成)——观察单平台使用率后决定;
- 文案历史/收藏库;
- A 方向(语义选材接入)在 M2 里程碑另行设计。

## 验收标准

1. `parseCopyResponse` 对 正常 JSON / 带围栏 / 坏 JSON / 缺字段 / tags 带#号 五类输入行为正确(单测);
2. `buildCopyPrompt` 五平台风格要点齐全且 JSON 约束在 system 消息中(单测);
3. IPC 入参校验拒绝空标题与非法平台(单测);
4. 门禁三连(npm test / vue-tsc / electron tsc)全绿。
