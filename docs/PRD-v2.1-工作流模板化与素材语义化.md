# PRD v2.1 — 工作流模板化与素材语义化

> 版本:2.1.0 | 状态:设计中 | 前置:v2.0(文本即时间线)
> 定位:v2.0 打通"文本精剪"能力后,v2.1 聚焦**效率复利**——把重复操作沉淀为可复用的模板与流水线(C),让素材库可被语义理解(A),并深化矩阵运营(B)。
> 交付顺序(已确认):**C 工作流模板化 → A 素材库语义化 → B 矩阵运营深化**。

## 1. 背景与目标

v2.0 交付了文本即时间线与断点续渲,单次创作链路已顺;但三处摩擦仍在:

1. **参数重复配置**:每次随机混剪都要重选文件夹、抽取数、转场、字幕、配音等十余项参数;
2. **管线手动串联**:素材分割 → 混剪 → 发布需用户逐页手动操作、手动衔接产物;
3. **素材靠记忆找**:素材库只有文件名与手动标签,想找"海边日落的镜头"只能肉眼翻。

本版本三个目标:

1. **工作流模板化(C)**:任务级参数模板 + 全自动步骤串联成管线 + 定时自动执行;
2. **素材库语义化(A)**:CLIP 语义索引,自然语言搜素材、自动打标签、语义去重;
3. **矩阵运营深化(B)**:多账号分组管理、账号维度数据对比、内容-账号匹配建议。

## 2. 用户故事

- 作为混剪用户,我把当前混剪参数存为"剧情号-3段式"模板,下次下拉一选即可开跑。
- 作为流水线用户,我定义"分割→随机混剪→自动发布"管线,一键跑完整链,中途失败自动停。
- 作为流水线用户,我给管线设每天 20:00 定时,到点自动执行并在任务中心看结果。
- 作为素材库用户,我输入"海边日落空镜"即可搜出语义相关的素材,不用记得文件名。
- 作为矩阵运营者,我能按账号分组看数据对比,系统建议"这条更适合发 B 号"。

## 3. 功能需求(FR)

### FR-1 任务级参数模板(优先级 P0,M1)

- 现有 `config-service` 的 `ConfigTemplate` 仅覆盖全局配置快照,不覆盖单次任务参数(文件夹多选、抽取数、转场、字幕、水印、TTS 等);本 FR 新增**任务级**模板。
- 数据:`userData/templates/mix-templates.json`(照 schedule-store 的 load/persist 注入模式):
  `MixTemplate { id, name, description?, params(MixParams 快照), createdAt, updatedAt }`
- 服务:`template-store.ts` 纯函数 + 依赖注入;IPC `mix-template:save / list / load / delete`,入参逐字段校验。
- UI:随机混剪页顶部「📌 存为模板」+ 模板下拉;加载模板即套用全部 MixParams,带成功提示。

### FR-2 自动管线(优先级 P0,M1)

- 数据:`userData/pipelines/pipelines.json`:
  `Pipeline { id, name, steps: Step[], schedule?, createdAt, updatedAt }`;
  `Step = material-split | video-mix-random | auto-publish`(全自动步骤池,每步带自己的 params)。
- 执行:`pipeline-runner.ts` 串行执行;前一步产物(输出文件/目录)自动作为下一步输入;每步进度入任务中心;**任一步失败即停**,后续步骤标 `blocked`。
- 人工步骤(文本精修)不进链;链完成后给"建议下一步"入口(精修/发布按钮)。
- UI:新视图「自动流水线」——左侧管线列表,右侧步骤编排(添加/删除/排序 + 每步参数表单)。

### FR-3 定时跑管线(优先级 P1,M1)

- `Pipeline.schedule?: { kind: 'daily' | 'weekly' | 'once', at: 'HH:mm', weekday? }`;
- 复用 auto-publish 的 SchedulerScheduler 轮询模式(注入 timer,纯编排可测),到点自动入队执行并记录结果;
- UI:流水线卡片上设置定时 + 启停开关;最近一次执行结果一览。

### FR-4 素材语义索引与自然语言搜索(优先级 P0,M2)

- 入库/批量索引:每素材取 1 秒处帧(`clip.embedVideoFrame(path, 1)`,复用 IClipService)→ 512 维 L2 归一化向量,落 `userData/semantic-index.json`;
- 索引存储:`{ [materialId]: { path, folderId, vector, tags, indexedAt } }`;后台任务入任务中心(type=`semantic-index`),断点续建(跳过已索引),素材删除同步清索引;
- 自然语言搜索:查询文本 → `clip.embedText` → 与全量索引算余弦(向量已归一化,余弦=点积)→ Top-K + 阈值过滤(默认 0.25,可调);结果含文件名/所属文件夹/相似度;
- 自动标签:zero-shot 词表投票——预设 3 组词(场景/主体/风格),每组 `embedText` 一次,与素材帧向量算相似度取 argmax,得 3 个标签写回索引;
- 索引纯函数(余弦/Top-K/阈值过滤/argmax 标签)与 CLIP 调用分离,支持断点续建(已有向量的素材跳过);
- IPC:`semantic:build / status / search / remove`(safeHandle);`shared/types.ts` TaskType += `'semantic-index'`;
- UI:素材处理页顶部搜索框 + 结果面板(文件名 + 所属文件夹 + 相似度)。

### FR-5 语义去重与智能推荐(优先级 P1,M2)

- 语义去重:索引向量两两余弦 ≥ 0.95 视为近重复 → 分组展示,一键移除组内冗余(保留其一);
- 与 v1.7 dHash 感知哈希去重互补:感知去重抓"同图不同格式",语义去重抓"同景别不同素材";
- 选材推荐(M2 范围内先做检索式):热点选题/AI 剪辑生成脚本后,按语义相似度推荐 Top-N 素材(复用 semantic:search)。

### FR-6 矩阵账号分组与对比(优先级 P1,M3)

- 现状约束:发布体系为平台级单账号(每平台一次登录),分组落地为「平台分组矩阵」——用户自定义分组 = 名称 + 平台集合;
- 数据:`userData/auto-publish/matrix-groups.json`:`Group { id, name, platforms: PublishPlatform[] }`;纯函数 + load/persist 注入(照 schedule-store);
- 发布记录的 `platform` 字段天然映射到分组,发布链路零改动;
- 聚合纯函数 `aggregateByGroup(records, groups, days)`:各分组近 7/30 天总播放/互动/发布数(复用 analytics-store 数据);
- UI:自动发布页「数据看板」新增「矩阵对比」视图——分组管理(增删改:名称 + 勾选平台)+ 横向 SVG 条形图(播放/互动两指标可切,沿用 v1.7 自绘风格,零新依赖);
- IPC:`matrix-groups:save / list / delete`。

### FR-7 内容-账号匹配建议(优先级 P2,M3)

- 纯函数 `suggestGroups(title, records, groups, topN=3)`:标题与各分组历史内容标题的字符 bigram 相似度 + 分组历史平均互动率(互动/播放,记录级回退 0)加权 → Top-3 分组建议(含分数);
- 权重:标题相似度 0.6 + 历史互动率 0.4(常量导出);
- 可选 LLM 解释文案(温度 ≤0.3,JSON 容错解析,剥离 markdown 围栏;未配 LLM 时仅出分数不报错);
- UI:矩阵对比视图底部「新作品该发哪组?」输入标题 → Top-3 建议(分数 + 可选解释)。

## 4. 技术方案要点

- 纯函数与编排分离:`template-store` / `pipeline-runner`(注入步骤执行器)/ 语义相似度 / Top-K 全部可 node:test 单测,`__tests__/*.spec.ts` 全覆盖;
- IPC 新模块在 `electron/ipc/index.ts` 的 registerAllIpc 注册;`safeHandle` 包装 + `{ok, data, error}` 返回;
- 定时复用 schedule-store 状态机思路:合法流转表 + 拒绝非法流转 + 每次变更即写盘;
- 语义索引沿用 clip 服务的模型下载经验(Chrome UA + 302 跟随);索引文件落 userData;
- 渲染层 IPC 传参深拷贝(`JSON.parse(JSON.stringify())`),禁止直传响应式对象;
- 零新增运行时依赖(除复用现有 ONNX/CLIP 栈)。

## 5. 里程碑

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M1 | FR-1/2/3 工作流模板化 | 模板存取 + 管线一键跑 + 定时执行,全部带单测 |
| M2 | FR-4/5 素材语义化 | 自然语言搜索命中、语义去重、推荐接入选材 |
| M3 | FR-6/7 矩阵深化 | 账号分组看板 + 匹配建议 |

## 6. 非目标(Non-Goals)

- 不做通用 DAG 编排器(任意步骤自由连线)——YAGNI,人工步骤本质上需要人看画面;
- 不做云端同步模板/管线(仍是本地 JSON 落盘);
- 不做跨设备素材同步。
