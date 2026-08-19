# flavor-lite 自进化方向探索报告

> 探索目标：基于当前项目架构与 `.flavorlite/plugins/evolve` 插件现状，评估五个自进化方向的可行性：
> 1. prompt/plan 自进化
> 2. 工具/插件自进化
> 3. 自沉淀 skill（针对任务生成 SOP）
> 4. memory 自进化
> 5. SFT（数据管线）
>
> 本文档为探索性沉淀：架构快照 → evolve 现状 → 分方向评估 → 优先级建议。
> 配套文档：`docs/evolve.md`（插件模式自进化路线图，偏部署层）、`docs/plugin-dev.md`（插件契约权威文档）。

## 1. 架构快照

flavor-lite 是"一切皆插件"的 agent 外壳。自进化能力全部挂在固定接缝上：

- **内核**（`src/kernel/`）：service 仓库 + effect 栈 + waterfall 钩子（around-middleware）。
  插件是 `{ name, inject, provides, apply(ctx, config) }`，注册返回可逆 disposer。
- **核心服务**：`llm`、`tools`、`hooks`、`commands`、`systemPrompt`、`session`、
  `agent`（loop）、`skills`、`memory`、`pluginsLoader`、`permission`、`router`。
- **六个钩子**（所有进化行为的接缝载体）：

| 钩子 | 载荷 | 对自进化的意义 |
|---|---|---|
| `prompt/assemble` | `{ cwd, sections[] }` | 动态注入/修改系统提示 section |
| `loop/before-request` | `{ messages, systemPrompt, tools }` | 每轮请求前的召回/记忆注入 |
| `loop/after-run` | `{ iterations, reason, toolCalls, toolErrors, steers, inputTokens, outputTokens }` | 会话结束反思、度量、沉淀 |
| `loop/compact` | `{ messages }` | 上下文溢出裁剪 |
| `tools/before-call` | `{ toolCall, tool, args, block? }` | 权限策略、动态召回 |
| `tools/after-call` | `{ toolCall, args, result }` | 失败捕获、结果审计 |

- **磁盘插件**（`.flavorlite/plugins/<name>/`）：`flavor-plugin.json` + 纯 ESM `index.js`。
  支持热重载（`/plugin reload`）、沙箱 dry-run（`loader.verify`）、快照回滚
  （`.versions/<name>/`，留 5 份）、eager/dynamic 激活、watch 同步、坏插件隔离。
- **技能**（`.flavorlite/skills/<name>/SKILL.md`）：front-matter 的 `name`/`description`
  注入 prompt，正文由模型按需 `Read`（`src/plugins/skills/index.ts`）。
- **会话**（`.flavorlite/sessions/*.jsonl`）：完整持久化 user/assistant/tool 消息，
  是天然的 SFT 语料（`src/shared/messages.ts` 定义了 provider 无关的 Message 结构）。

## 2. evolve 插件现状

`.flavorlite/plugins/evolve/`（`index.js` + `store.js`）已实现一个有边界、人工把关的 RSI 闭环：

```
捕获（tools/after-call 记失败）→ 聚合（按工具+归一化错误去重）
→ 评估（prompt/assemble 注入建议）→ 改进（evolve_improve 工具 / /evolve 命令）
→ 验证（/evolve verify 沙箱 + /evolve test）→ 回滚/关闭（revert / done）
```

- **数据文件**：`.flavorlite/evolve/signals.jsonl`（失败信号，按 `(tool, 归一化错误)` 指纹去重，
  只记参数名不记值，避免泄密）、`reflections.jsonl`（每轮 run 统计 + `signalDelta` 度量改进是否生效）、
  `done.json`（已处理的建议 id）。
- **注入方式**：系统提示中 "self-improvement suggestions (evolve plugin)" 章节列出重复失败建议，
  由模型判断是否当场实现；实现走 `evolve_improve` 工具脚手架 `fix-<tool>/` 插件目录 + PLAN.md。
- **局限**（探索中确认）：
  - 只对**失败**反应，不学习成功轨迹；
  - `/evolve test` 跑宿主 `npm test`，与生成的插件无直接关联；
  - 系统提示中 `evolve_improve` 描述声明 `kind=plugin|prompt_rule`，但源码只实现了
    `plugin` 分支，`prompt_rule` 分支**不存在**——文档与实现不一致；
  - 当前 signals 数据为早期测试探针残留，无真实积累。

## 3. 分方向评估

### 3.1 prompt/plan 自进化 —— ✅ 可行，基建现成

**prompt**：`prompt/assemble` 是纯 waterfall，任何插件可动态注入 section（evolve 已注入建议、
memory 已注入用户偏好）。成功经验可沉淀为规则文件（如 `.flavorlite/evolve/rules.md`），
每次 assemble 注入，实现"行为规则自增长"。

**plan**：需扩展。`task-planner`（`.flavorlite/plugins/task-planner/index.js`）的
`createStore` 是纯内存态：无持久化、不提供 service、无结束钩子。要自进化需：

1. 新增 `plan_end` 工具，把任务序列（goal + tasks + 每步成败）序列化落盘；
2. 成功计划存为可复用模板，失败计划存为反模式；
3. 复用 `loop/after-run` + session 读完整轨迹做提炼。

### 3.2 工具/插件自进化 —— ✅ 已实现核心闭环，可增强

evolve 已覆盖"失败 → 修插件"。增强方向：

- **从成功轨迹提议新工具**：`loop/after-run` 分析会话中高频重复的工具序列
  （如"查文件→搜内容→读文件"），超过阈值时提议封装为新工具/命令——目前只对失败反应，
  不会主动发明能力；
- **更强验证**：`loader.verify` 只证明插件能加载注册，可给生成插件加"自检模式"
  （dry-run 时实际执行一个最小用例）；
- **修复文档/实现不一致**：补 `evolve_improve` 的 `prompt_rule` 分支（小改动）。

### 3.3 自沉淀 skill（SOP）—— ✅ 可行，架构支持，需新增生成逻辑

skills 插件已支持发现 + 注入，缺的是"生成"端。可完全照 memory 插件的
`extractMemories` 模式（`.flavorlite/plugins/memory/index.js`）实现：

1. `loop/after-run` 用 LLM 从成功会话提炼 SOP 草稿；
2. 写入 `.flavorlite/skills/<name>/SKILL.md`；
3. 下次会话 skills 插件自动发现并注入（name/description 进 prompt，正文按需 Read）。

需设防滥用门槛：任务成功 + 步骤数足够多才提炼；生成标注 `generated: true`；
写文件走 `tools/before-call` 权限系统（写 `.flavorlite/` 属本地可逆操作）。
**这是 1–4 里 ROI 最高的新能力。**

### 3.4 memory 自进化 —— ✅ 已基本自进化，仅剩增强点

已实现：自动抽取（`loop/after-run` LLM 提炼，`.flavorlite/plugins/memory/index.js`）、
混合召回（BM25 + 可选向量，`loop/before-request` 注入）、用户偏好直接注入、
冷记忆淘汰（`/forget-cold`）、向量嵌入可选（`.flavorlite/memory/embedding.json`）。

剩余增强：失败经验 → 记忆的通路（error-monitor 已写 `memory/tasks/tool-errors.md`，
可纳入 evolve 建议闭环）；记忆合并巩固。本质上是其它自进化方向的存储层，无需重做。

### 3.5 SFT —— ⚠️ 数据管线可行，训练必须外接，最重方向

- **数据收集（可行）**：`sessions/*.jsonl` 的 Message 结构（`user` / `assistant`+`toolCalls` /
  `tool`）正是 provider 无关格式，导出器可直接转 OpenAI/DeepSeek fine-tune JSONL；
  可用 `reflections.jsonl` 的 `toolErrors`/`signalDelta` 过滤高质量轨迹。
- **训练（必须外接）**：flavor-lite 无训练能力。OpenAI 适配器是裸 fetch
  （`src/plugins/llm/openai.ts`），可新增 `/fine_tuning/jobs` 调用做成独立 sft 插件，
  或离线用本地工具训练。
- **部署切换（可行）**：fine-tune 后的 model id 通过 `provider:model` 引用
  + `.env`/config 切换即可。
- **现实建议**：SFT 需要数百条高质量轨迹且涉及外部费用与数据隐私，应放最后；
  1–4 是上下文/工具/经验工程，能覆盖绝大部分收益。

## 4. 优先级建议

| 方向 | 状态 | 实现成本 | 建议 |
|---|---|---|---|
| 4 memory | 已自进化 | — | 不动，只打通 evolve ↔ memory 通路 |
| 2 工具/插件 | 核心闭环已有 | 低 | 增强：成功轨迹→新工具提议；补 prompt_rule 分支 |
| 1 prompt/plan | 基建现成 | 中 | plan 需先给 task-planner 加持久化（plan_end） |
| 3 skill SOP | 架构支持 | 中 | 新插件，复用 memory 抽取模式 |
| 5 SFT | 数据可行 | 高（外接） | 独立插件，远期 |

推荐起步顺序：

1. **3（自沉淀 skill）**：纯本地、可逆、收益直接，架构完全支持；
2. **1 的 plan 持久化**：task-planner 加 plan_end + 模板沉淀；
3. **2 的增强**：成功轨迹分析 + `prompt_rule` 分支补齐；
4. **5（SFT）**：独立插件，等 1–4 积累出足够高质量会话后再做。

## 附：相关资产索引

| 资产 | 位置 | 在自进化中的角色 |
|---|---|---|
| evolve 插件 | `.flavorlite/plugins/evolve/` | RSI 闭环：捕获/聚合/改进/验证 |
| task-planner | `.flavorlite/plugins/task-planner/index.js` | plan 状态（当前内存态，待持久化） |
| memory 插件 | `.flavorlite/plugins/memory/` | 声明式知识沉淀 + LLM 自动抽取 |
| skills 插件 | `src/plugins/skills/index.ts` | skill 发现 + prompt 注入（生成端缺失） |
| error-monitor | `.flavorlite/plugins/error-monitor/` | 失败信号积累（可并入 evolve 闭环） |
| pluginsLoader | `src/plugins/plugins/index.ts` | 部署层：热重载/verify/快照回滚 |
| 会话存储 | `.flavorlite/sessions/*.jsonl` | SFT 语料源（provider 无关 Message 结构） |
| loop 钩子 | `src/plugins/loop/index.ts` | after-run/before-request 载荷定义 |
| plugin-dev 规范 | `docs/plugin-dev.md` | 插件契约权威文档 |
| 路线图 | `docs/evolve.md` | 部署层自进化路线图（本报告侧重方向评估） |
