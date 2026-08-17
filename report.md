# flavor-lite 项目探索报告

> 探索日期：2026-08-17
> 测试验证：`npm test` 实测 **19 个测试文件 / 238 个用例**（234 通过 / 4 失败，失败集中在两个磁盘插件集成测试，详见第八节）

---

## 一、这是什么项目？

**flavor-lite** 是一个**轻量级 AI 编程助手（coding agent）**，用 TypeScript 编写。它不是一个传统的框架，而是一个**"万物皆插件"（Everything is a plugin）**的微型内核——整个智能体循环（agent loop）本身都是插件。

简单说：你向它下达一个任务（比如"帮我在 README 里加一段测试说明"），它会像一个人一样——
读代码 → 想方案 → 调用工具（读文件、改文件、跑命令）→ 再读结果 → 继续思考，直到完成。

### 它借鉴了哪些思想？

| 灵感来源 | 借鉴了什么 |
|---|---|
| deepseek-harness (Cordis) | 微型内核 + 可插拔能力缝（plugin seams） |
| flavor-code | 权限模式、FLAVOR.md 项目指南、JSONL 会话、分节的系统提示词 |
| pi | 事件驱动的流式循环、steering 消息（运行中实时插话）、工具钩子 |

### 为什么它"快"？

- **零 SDK 依赖**：调用大模型用的是原生 `fetch` + 手动解析 SSE 流，唯一运行时依赖是 `zod`（做配置校验）
- **不做二次审阅**：只有一条流，直接输出到终端
- **启动时一次性拓扑排序**：插件加载顺序启动时确定，运行期零分发开销
- **实时流式输出**：文本逐字到达，逐字渲染
- **只在值得重试的地方重试**：网络/限流错误在未输出任何内容前做指数退避重试

### 与 8-15 版报告相比新增了什么？

| 类别 | 新增内容 |
|---|---|
| 内核 | 瀑布钩子独立成 `hooks` 插件；模型提供商发现也插件化（`providers.ts`） |
| 宿主 | REPL 斜杠命令补全（`host/completions.ts`）、渲染可委托给 `ui` 服务 |
| 内核级插件 | **磁盘插件加载器**（`.flavorlite/plugins/` 热重载）、**路由插件**（dynamic 插件按需召回） |
| 文档/模板 | `docs/plugin-dev.md` 插件开发规范、`/plugin new` 脚手架模板 |
| 磁盘插件生态 | 10 个功能插件：memory、error-monitor、websearch、subagent、astgraph、flavor-ui、filediff、clear-context、command-hints、task-planner |

---

## 二、技术栈与工程配置

| 项目 | 内容 |
|---|---|
| 语言 | TypeScript（strict 模式 + `noUncheckedIndexedAccess`） |
| 包管理器 | npm |
| 版本 | 0.1.1 |
| Node 要求 | >= 20（astgraph 插件额外要求 >= 22.5，用 `node:sqlite`） |
| 运行时依赖 | 仅 `zod`（^4.4.3） |
| 开发依赖 | `tsup`（打包）、`typescript@7`、`vitest`（测试） |
| 输出格式 | ESM，`tsup` 打包成 `dist/cli.js` 和 `dist/index.js` |
| 入口 | CLI 二进制：`flavor-lite`；SDK 入口：`src/index.ts` |

### 常用命令

```bash
npm test          # 运行全部单元测试（vitest）
npm run typecheck # 类型检查（tsc --noEmit）
npm run build     # tsup 打包到 dist/
npm start         # node dist/cli.js 启动
```

### 工程文件速览

- `tsconfig.json`：严格类型检查，`noEmit`（打包交给 tsup）
- `tsup.config.ts`：入口 `cli` 和 `index`，只输出 ESM；`dts` 关闭（TypeScript 7 兼容问题），需要类型声明时跑 `npm run types`
- `vitest.config.ts`：只收集 `tests/**/*.test.ts`，Node 环境，超时 20 秒
- `.env.example`：模板，只需设置一个 API Key（OpenAI 系或 Anthropic 系）即可运行
- `docs/plugin-dev.md`：**插件开发规范**，磁盘插件契约的唯一权威文档
- `templates/plugin-template/`：`/plugin new` 用的脚手架模板（源码里也内嵌了一份，保证 dist 自包含）

---

## 三、目录结构

```
flavor-lite/
├── src/
│   ├── index.ts                  # 公共 SDK 出口：把内核和所有插件统一导出
│   ├── cli.ts                    # CLI 入口：解析参数 → createAgent → REPL 或一次性运行
│   ├── kernel/                   # 微型内核（mini-Cordis）
│   │   ├── types.ts              #   类型：Plugin、PluginContext、Logger、ServiceMap 等
│   │   ├── context.ts            #   上下文：服务仓库 + 事件总线 + 可逆效果栈
│   │   ├── runtime.ts            #   运行时：挂载插件、拓扑排序、逆序卸载
│   │   └── index.ts              #   内核公共出口
│   ├── shared/
│   │   └── messages.ts           # 与厂商无关的消息模型 + 历史清洗
│   ├── plugins/                  # 内核级能力插件
│   │   ├── hooks/                #   【新】瀑布钩子总线插件（hooks 服务）
│   │   ├── llm/                  #   大模型能力缝：适配器注册表、SSE 解析
│   │   │   ├── providers.ts      #   【新】提供商发现插件化：openai/anthropic 各自独立成插件
│   │   ├── tools/                #   工具能力缝：工具注册表 + before/after 钩子 + 7 个内置工具
│   │   ├── permission/           #   权限插件：4 种模式 + 危险命令硬拦截
│   │   ├── session/              #   会话插件：.flavorlite/sessions 下的 JSONL 持久化
│   │   ├── prompt/               #   提示词插件：纯装配器，只负责拼接各插件贡献的节
│   │   ├── guidance/             #   引导插件：身份/安全/任务/环境 四个提示词节
│   │   ├── loop/                 #   智能体循环插件：流式、steering、重试、压缩钩子
│   │   ├── compaction/           #   历史压缩插件：主动+被动裁剪上下文
│   │   ├── skills/               #   技能插件：SKILL.md 发现 → 提示词节
│   │   ├── commands/             #   斜杠命令注册表
│   │   ├── init/                 #   项目指南插件：FLAVOR.md 注入 + /init 生成器
│   │   ├── plugins/              #   【新】磁盘插件加载器：发现/热重载/目录监听/脚手架
│   │   │   └── template.ts       #       /plugin new 的内嵌脚手架模板
│   │   └── router/               #   【新】路由插件：dynamic 插件按需召回 + 空闲弹出
│   └── host/                     # 宿主层：装配、配置合并、终端交互、渲染、REPL
│       ├── bootstrap.ts          #   createAgent：唯一的组合根，挂载全部默认插件
│       ├── config.ts             #   多源配置合并（用户/项目/环境/CLI），zod 校验
│       ├── interaction.ts        #   终端交互实现（权限确认）
│       ├── render.ts             #   事件渲染：零依赖 ANSI 颜色；可委托给 ui 服务
│       ├── completions.ts        #   【新】REPL 补全控制器：repl 服务 + 建议渲染 + Tab 补全
│       └── repl.ts               #   交互式 REPL
├── docs/
│   └── plugin-dev.md             # 【新】插件开发规范
├── templates/
│   └── plugin-template/          # 【新】/plugin new 脚手架模板
├── .flavorlite/plugins/          # 【新】磁盘插件根（本项目自带的 10 个插件）
│   ├── memory/                   #   长期记忆：BM25 + 向量 + RRF 混合检索
│   ├── error-monitor/            #   工具错误监控 + LLM 分析蒸馏到记忆
│   ├── websearch/                #   网络搜索：DuckDuckGo / Brave / SearXNG
│   ├── subagent/                 #   子代理：最多 3 层嵌套，独立会话
│   ├── astgraph/                 #   代码图谱：ast_search/callers/callees/impact/context
│   ├── flavor-ui/                #   时间线 UI：banner、spinner、工具卡片
│   ├── filediff/                 #   文件修改后终端打印 +/- diff
│   ├── clear-context/            #   /clear：清屏 + 重置上下文
│   ├── command-hints/            #   REPL 斜杠补全候选提供者
│   └── task-planner/             #   任务规划：彩色任务面板
├── tests/                        # 19 个测试文件，238 个用例
└── dist/                         # 构建产物（已 gitignore）
```

---

## 四、核心架构：微型内核

整个项目最核心的设计是 **kernel**，它提供了 4 个基础概念，所有插件都建立在这些概念之上。

### 1. 服务仓库（Context 是什么？）

`Context`（`src/kernel/context.ts`）就是一个**按字符串键存储服务的 Map**，加上事件总线和效果栈。所有插件通过它互相通信，而不是互相 import。

- `ctx.provide(key, service)`：注册一个服务，返回一个"撤销函数"
- `ctx.get(key)`：取服务，**取不到就抛错**（fail loud，绝不静默）
- `ctx.tryGet(key)`：取服务，取不到返回 `undefined`
- `ctx.emit / ctx.on`：事件发布 / 订阅（观察者模式）
- `ctx.hook / ctx.waterfall`：**瀑布钩子**（见下文）
- `ctx.effect(setup)`：登记一个可逆效果，卸载时按**逆序**回滚

```ts
// 一段生动的理解：
ctx.provide("llm", llmService)   // 谁需要大模型，就 ctx.get("llm")
const dispose = ctx.on("event", handler)  // 订阅事件
dispose()                          // 随时可退订，一切可逆
```

### 2. 瀑布钩子（Waterfall，环绕中间件）

8-15 版里瀑布钩子内嵌在 Context 中；**现在它独立成了 `hooks` 插件**（`src/plugins/hooks/index.ts`）。内核只保留服务仓库和效果栈，环绕中间件全部住在 hooks 插件里——**卸掉这个插件，就不存在任何钩子点了**，"插件，而不是改循环"的纯度更高。

```ts
ctx.hook("tools/before-call", async (event, next) => {
  console.log("工具要开始跑啦");
  const result = await next(event);   // 传给下一层
  console.log("工具跑完了");
  return result;
});
```

新特性：`hook(name, listener, { prepend: true })` 可以把监听器插到链头（最外层）——路由、策略类插件靠它保证在任何其他监听器之前看到载荷。

### 3. 插件的声明式元数据

每个插件声明 `name`（名字）、`inject`（需要哪些服务）、`provides`（提供哪些服务）、`apply`（激活逻辑，返回一个卸载函数）：

```ts
export const myPlugin = definePlugin({
  name: "my-plugin",
  inject: ["tools"],        // 依赖的工具服务
  apply(ctx) {
    return ctx.effect(() => {
      const dispose = ctx.hook("tools/before-call", ...);
      return dispose;       // 卸载时自动回滚
    }, "my-plugin.install");
  },
});
```

### 4. 启动时的拓扑排序（Runtime）

`Runtime`（`src/kernel/runtime.ts`）启动时根据 `inject`/`provides` 做**拓扑排序**——不管插件按什么顺序挂载，有依赖的插件一定在提供者之后激活：

- 依赖缺失 → 启动即抛错
- 服务重复提供 → 启动即抛错
- 依赖成环 → 启动即抛错（还会打印出环的路径）

这种"错在启动时爆、不在运行中藏"的设计，是整个项目"fail loud"哲学的体现。卸载时则按激活的**逆序**逐个执行卸载函数，保证世界干净地回到原点。

### 5. 【新】提供商发现也插件化了

`src/plugins/llm/providers.ts`：OpenAI / Anthropic 各自是独立插件（`openaiProviderPlugin` / `anthropicProviderPlugin`），有 API Key 就自我注册适配器，没有就静默跳过。组合根（bootstrap）**完全不碰适配器实现和环境变量**，只做一个通用检查：无论内置还是第三方，只要最终 `llm.providers().length === 0` 就启动即抛错。第三方提供商现在可以走和内置一模一样的路径。

---

## 五、消息模型（Model-visible ⇔ Logged）

`src/shared/messages.ts` 定义了与厂商无关的消息模型：

- `user`：用户消息（纯文本）
- `assistant`：助手消息（文本 + 可选 toolCalls）
- `tool`：工具结果（对应某个 toolCallId）

`sanitizeHistory()` 是一个很聪明的**历史修复函数**：如果对话中助手发起了工具调用但结果不完整（比如中途被中止、会话文件写了一半、压缩裁掉了），直接发给模型会被拒绝。它会把悬空的工具调用组改写成普通文本、丢弃孤儿工具结果，保证**任何情况下发给模型的历史都是合法的**。

会话插件坚持"模型能看到的 ⇔ 被记录的"：所有进入模型请求的消息都会被追加到会话 JSONL，因此一个会话文件可以完整还原一段对话。

---

## 六、能力缝插件详解

### 1. LLM 插件（`plugins/llm/`）——大模型提供商

- 提供 `llm` 服务，内部是一个**适配器注册表**
- 每个提供商是一个 `ModelAdapter`（`stream(request)` 返回异步事件流）
- 模型引用形式是 `"provider:model"`，比如 `openai:gpt-5`、`anthropic:claude-sonnet-4-5`；裸名字默认归到 `openai`
- **OpenAIAdapter**：兼容 OpenAI、DeepSeek、Moonshot、vLLM、Ollama 等任何 OpenAI 兼容网关，纯 `fetch` + SSE 流式解析，自动累加 tool_calls 分片
- **AnthropicAdapter**：走 Anthropic Messages API，同样纯 fetch 流式
- 错误统一归一化为 `ProviderError`，带语义化错误码：`authentication`（401/403）、`rate_limit`（429）、`context_overflow`、`model_not_found`、`network`、`cancelled`
- **提供商注册改为独立插件**（见第四节第 5 点），第三方可完全复刻

### 2. 工具插件（`plugins/tools/`）——智能体的"手脚"

工具注册表（`ToolRegistry`）提供 4 类工具，每个工具都声明自己的 JSON Schema：

| 类别 | 工具 | 说明 |
|---|---|---|
| read | `Read` | 读文件，支持 offset/limit，超 120k 字符自动截断 |
| write | `Write` | 写文件（自动建父目录） |
| write | `Edit` | 精确文本替换，支持 replaceAll |
| read | `Glob` | 按通配符找文件（`**`、`*`、`?`），纯 Node 实现 |
| read | `Grep` | 正则搜索文件内容，跳过二进制，限制 200 条 |
| shell | `Shell` | 跑命令，带超时（默认 120s）和输出截断 |
| control | `TodoWrite` | 任务清单跟踪（进程内状态） |

工具执行时先过 `tools/before-call` 瀑布（权限插件在这里拦截），再执行，最后过 `tools/after-call` 瀑布（可改写结果）。**执行任何工具都不会抛异常**——错误会变成 `isError: true` 的结果返回给模型，让模型自行修复。

安全细节：所有文件工具都做**工作区边界检查**（`isWithinWorkspace`），禁止 `..` 逃逸。

### 3. 权限插件（`plugins/permission/`）——安全护栏

四种权限模式：

| 模式 | 行为 |
|---|---|
| `plan` | 只读；写文件、shell 全部拦截 |
| `default` | 读自动放行；写、shell 按类别询问一次 |
| `acceptEdits` | 读+写自动放行；shell 询问 |
| `bypass` | 全部放行（除了下面的硬危险命令） |

**任何模式下都硬拦截**的危险命令模式包括：`rm -rf /`、`mkfs`、`format C:`、`dd of=/dev/`、关机/重启、fork 炸弹、注册表删除等。

询问需要 `interaction` 服务（CLI 里是终端交互）。**没有 interaction 服务时默认拒绝**（fail closed）。批准按 `模式:类别:目录` 记录，一次批准本会话内记住，切换模式会清空记忆。

### 4. 会话插件（`plugins/session/`）——JSONL 持久化

- 每个会话是一个文件：`.flavorlite/sessions/<时间戳>-<随机数>.jsonl`
- 追加式写入，每行一个 JSON（header/message/title）
- 打开时会**隔离损坏的行**（崩溃残留的截断行被跳过，不丢整个文件）
- 提供 `create/open/latest/list` 服务，支持 `/sessions`、`/resume`、`/new` 命令

### 5. 提示词插件（`plugins/prompt/`）——纯装配器

系统提示词是**运行时拼出来的**：`prompt/assemble` 瀑布从空节列表开始，各插件往 `sections` 里推自己的节，最后去重（同名后者覆盖）、按 `# 节名` 格式拼接。

谁贡献节？

- `guidance` 插件：Identity（身份）、Security（安全）、Tasks（任务）、Environment（环境）
- `permission` 插件：Permissions（当前模式）
- `shell` 工具插件：Shell（平台提示）
- `skills` 插件：Skills（可用技能）
- `init` 插件：Project guide（FLAVOR.md 内容）
- **磁盘插件**：memory（用户偏好）、error-monitor（过往错误教训）、subagent（委派指引）、flavor-ui 等各插自己的节

**卸掉某个插件，它的节就消失**——系统提示词完全由插件决定，这是"一切皆插件"最直观的体现。

### 6. 循环插件（`plugins/loop/`）——智能体的主循环

`agent` 服务实现 `run(options)` 异步事件流。一次 `run` 的流程：

```
用户输入 → 记录到会话
  ↓
进入 while 循环（最多 maxIterations=30 次）
  ↓
插入 steering 消息（运行中用户插话）→ loop/before-request 瀑布（压缩钩子、路由钩子）
  ↓
sanitizeHistory 修复历史
  ↓
调用 llm.stream() 流式请求，实时 yield text_delta/usage
  ↓
网络/限流错误且尚未输出 → 指数退避重试（最多 3 次）
  ↓
把 assistant 消息（含 toolCalls）记录到会话
  ↓
有工具调用？→ 逐个执行（yield tool_start/tool_end）→ 回到循环头部
没有工具调用？→ yield agent_end(finished)，结束
```

特性：
- **Steering**：turn 运行中输入的文字会变成 `[steering] ...` 用户消息，注入到下一个模型请求之前——不用重启就能实时指挥
- **Abort**：`Ctrl+C` 中止当前 turn；被中止的工具调用会记录占位结果，保证会话数据"线格式合法"
- **Context overflow**：上下文溢出时调用 `loop/compact` 瀑布让压缩插件裁剪一次后重试
- **警告**：到达迭代上限 80% 时发 warning；`stopReason=length` 时也提示

### 7. 压缩插件（`plugins/compaction/`）——上下文瘦身

- **主动压缩**：挂在 `loop/before-request` 上，历史足迹超过预算（默认 160k 字符 ≈ 40k token）时裁剪中间部分，换成一条 `[system] Earlier conversation ...` 标记，尾部保留（默认 20 条）且裁切边界会回退，**绝不让工具结果成为第一条**
- **被动压缩**：挂在 `loop/compact` 上，处理提供商仍报 context overflow 的情况

### 8. 其他内核级插件

- **skills**：扫描 `.flavorlite/skills/<name>/SKILL.md`（项目）和 `~/.flavorlite/skills/`（用户全局），只把技能的名字和描述注入提示词，模型用到时再用 Read 工具读全文——保持提示词精简
- **commands**：斜杠命令注册表，宿主与插件都能注册
- **init**：FLAVOR.md 项目指南作为提示词节注入；`/init` 让 agent 自己探索项目并生成 `.flavorlite/FLAVOR.md`

---

## 七、【新】磁盘插件系统（`.flavorlite/plugins/`）

这是 8-15 之后最大的一块新能力：**不用改 flavor-lite 源码，往项目里放一个目录就是新插件，改完 `/plugin reload` 即刻生效**。磁盘插件与内置插件使用完全相同的契约。

### 1. 加载器插件（`src/plugins/plugins/`）——发现、热重载、监听

- **发现根**：`<项目>/.flavorlite/plugins/`（项目）→ `~/.flavorlite/plugins/`（用户全局），同名按 manifest 里的 `name` 项目遮蔽用户
- **目录结构**：每个插件 = `flavor-plugin.json`（manifest）+ ESM entry（默认 `index.js`），默认导出 `Plugin` 或 `Plugin[]`
- **manifest 字段**：`name`（必填）、`version`、`entry`、`description`、`config`（透传给 `apply(ctx, config)`）、`activation`（`eager` 启动即挂载 / `dynamic` 进目录但先不挂载，等路由插件召回）、`triggers`（路由提示：keywords / patterns / tools / commands）、`provides`（声明的服务键，用于跨插件依赖解析）
- **热重载**：`/plugin reload <name>` 卸载（按逆序跑 disposer）→ 用 cache-busting query 重新 import → 重挂载；`/plugin reload` 全量重发现，新目录自动出现、删除的自动卸载
- **目录监听**（默认开）：新插件自动进目录、移除的自动卸载；**已加载的插件永不被自动 sync 触碰**——正在跑的 turn 绝不被干扰，要换只能手动 `/plugin reload`
- **坏插件绝不炸宿主**：manifest 非法、import 失败、激活失败，全部标记为 `error` 记在目录里，其余继续跑
- **依赖解析**：eager 插件可以 inject 另一个磁盘插件提供的服务，加载器按 `provides` 声明递归装载 + 拓扑排序；eager 依赖 dynamic 提供的服务会启动即报错
- **/plugin 命令**：`list`（状态 + 错误 + provides）、`reload [name]`、`new <name>`（脚手架，从内嵌模板生成目录）
- **脚手架模板**（`templates/plugin-template/` + `src/plugins/plugins/template.ts`）：内嵌一份在源码里保证 dist 自包含；`/plugin new` 生成的工具/命令/提示词节三合一样板

### 2. 路由插件（`src/plugins/router/`）——dynamic 插件按需召回

dynamic 插件平时不占内存不占提示词；每个模型请求过一个**三级召回漏斗**，每次 `agent_end` 把没用上的弹出去：

- **L0 确定性**：manifest 声明的 `keywords`（大小写不敏感子串）/ `patterns`（正则）命中即召回——作者控制的精确匹配，微秒级
- **L1 倒排索引**：对 name / description / triggers 做 tokenize（英文单词 + CJK 单字/二元组，带停用词表），构建 IDF 加权倒排索引；目录变化才重建，查询路径是纯查找
- **L2 工具名回退**：挂在 `tools/before-call` 上——模型调了一个"当前不存在"的工具，如果某 dynamic 插件声明了它，当场挂载再执行——**零漏召回**
- **自适应反馈**：召回但没用上的配对降权、用了的加权，写入 `.flavorlite/router-memory.json`（滚动 200 条）；用指纹（去重排序的 token）判断"相似请求"，L0 命中永不绝不降权（作者声明是精确信号）
- **空闲弹出**：turn 结束时把加载了但没用到工具、也没有反向依赖的 dynamic 插件 eject 回目录（`pinned` 名单可豁免）
- 召回时往请求里插一条 `[system] Plugins activated for this task: ...` 消息并刷新工具 schema，让模型知道新工具可用

### 3. 自带磁盘插件（本项目 `.flavorlite/plugins/` 下的 10 个）

#### memory —— 长期记忆
- 存储：`.flavorlite/memory/MEMORY.md` 路由索引 + `tasks/<id>.md` 全文，文件锁 + 原子改名 + `.bak` 兜底，崩溃不丢
- 去重：归一化 + `similarity >= 0.92` 拒绝近似重复
- **混合检索**：BM25（稀疏）+ 外部 embedding 向量（稠密，OpenAI 兼容端点，Ollama 也可）→ **RRF 融合**；热度调制（hot +15% / cold −25%）
- 热度老化：7 天内召回 >10 次 = hot；3 天没动 = cold（`/forget-cold` 清理）
- 自动召回：`loop/before-request` 每轮把 top hits 追加进系统提示词（按 query 缓存）
- 自动提取：`loop/after-run` 用 agent 自己的 LLM 从对话里提取持久事实，置信度 ≥ 11/12 才自动入库；敏感内容（密钥、注入文本）拒绝
- 命令：`/memory`、`/remember`、`/forget`、`/forget-cold`、`/embedding`

#### error-monitor —— 错误监控 + LLM 蒸馏
- `tools/after-call` 钩子捕获 `isError: true` 的工具结果，按签名去重记录到 `.flavorlite/error-monitor/records.json`（`/errors` 查看）
- 对**每个新失败**，后台调用 LLM 分析（带平台/shell/cwd 环境、脱敏后的错误文本），要求返回严格 JSON `{"analysis": "...", "confidence": 0.0-1.0}`
- 只有 `confidence >= 0.7` 的分析才蒸馏成 `feedback` 记忆写进 memory 插件（`memoryStatus` 记录在每条 record 上，`/errors` 可直接看到 skipped 原因）
- 防呆：20s 超时中止、指数退避重试、串行化防爆、推理模型关 CoT（`thinking: "disabled"`）；LLM 失败默认**不写记忆**（除非显式 `fallbackToRules: true`）
- 教训注入：`prompt/assemble` 把最近的教训注入系统提示词，让模型在下一次规划工具前看到历史失败
- 命令：`/errors`、`/errors clear`、`/errors analyze`（对空回复的旧记录重新蒸馏）

#### websearch —— 网络搜索（dynamic）
- 工具 `websearch`（`query` / `maxResults` / `region`），category `read` 全权限放行
- 三提供商：DuckDuckGo lite（免费默认）、Brave API（需要 key）、自定义 SearXNG JSON 端点
- 零依赖纯 ESM，只用 Node 内置 fetch；超时/HTTP 错误作为错误结果返回给模型、绝不 throw
- 触发词包括中文（搜索/查一下/查资料/网页/新闻…）与英文（web/search）；`/websearch` REPL 命令是工具薄封装

#### subagent —— 子代理
- 工具 `subagent_spawn`（`task` / `role` / `maxIterations`）：让 agent 委派子任务给全新子代理
- 子代理：**独立会话**（历史不污染父级，父级只看最终报告）、专属系统提示词节（角色/任务/深度）、与父级相同的工具与权限策略、继承父级 abort 信号
- **最多 3 层嵌套**（root → child → grandchild → great-grandchild），深度用 `AsyncLocalStorage` 跟踪，不需要改 loop
- 报告保障三层：提示词预留迭代 → 静默时驱动 2 次收尾轮 → 仍静默就从会话日志重建工具调用摘要；报告头总带子会话 id 便于父级查全程
- 被拒绝的 spawn 不落盘（没有孤儿会话文件）

#### astgraph —— 代码图谱（dynamic，Node >= 22.5）
- 从 flavor-code 移植：用 tree-sitter（WASM）构建函数/类/接口/类型的调用、import、继承边，存进 `.flavorlite/astgraph/index.db`（`node:sqlite`，WAL）
- 工具：`ast_search` / `ast_callers` / `ast_callees` / `ast_impact` / `ast_context`
- 命令 `/ast`：init / sync / status / search / impact / callers / callees / context
- 懒加载：激活只注册处理器，WASM 语法与数据库首次使用才载入；`tools/after-call` 对文件修改做增量同步
- 低版本 Node 上加载正常、查询时给友好错误

#### flavor-ui —— 时间线 UI
- 宿主只拥有终端，但把渲染委托给可选的 `ui` 服务（`provides: ["ui"]`）——这个插件接管整个观感
- 每轮 turn 变成时间线：输入回显、模型文本实时流、工具调用 live 状态行（TTY 下 spinner 原地重写）、结尾 dim 统计行（turn 数 / token / 耗时）
- 启动 banner 变成状态卡片：版本、模型、权限模式（语义着色）、会话 id、插件健康、失败插件告警
- `/ui` 查看/切换样式（full 动画 / plain 静态）；非 TTY / `NO_COLOR` 自动退化为纯文本
- 卸载即恢复宿主默认渲染，无残留状态

#### filediff —— 文件变更 diff
- 文件修改工具（Write/Edit/ApplyPatch 及带 path 的 write 类工具）跑完后，终端立刻打印彩色 `+/-` diff
- 识别 shell 删除（rm/unlink/del/erase/rmdir/rd）与移动（mv/move/ren/rename）；目录递归扫描（有上限）
- diff 直接写 stdout、**绝不污染模型可见的工具结果**（ANSI 不进上下文）
- 可配置 color / maxDiffLines / maxFileBytes / maxTreeFiles

#### clear-context —— `/clear`
- 清屏（ANSI 转义）+ 重置上下文：会话文件重写为只剩 header，`loop/before-request` 把 clear 之前的消息从每次请求里裁掉
- 重写失败时请求时裁剪兜底，旧上下文仍然到不了模型

#### command-hints —— REPL 补全候选
- 输入以 `/` 开头时，把命令、插件、技能名渲染在输入行下方，前缀高亮，Tab 循环补全（命令 → `/name`；插件 → `/plugin reload <name>`；技能仅展示信息）
- 一次性 `-p` 模式下无 REPL，优雅 no-op

#### task-planner —— 任务规划面板
- 工具 `plan_start` / `plan_update` / `plan_view`：把复杂工作拆成原子任务，彩色面板（running 绿 / pending 橙 / error 红 / done 暗）直接画到终端
- 面板只在终端显示，模型只拿纯文本摘要——颜色不污染上下文
- `control` 类工具在 default/plan 模式下免询问，agent 可以自主规划

---

## 八、宿主层与配置

### createAgent() —— 组合根（`host/bootstrap.ts`）

这是唯一知道完整插件清单的地方：

```
hooks → llm → providers(openai/anthropic) → tools → guidance(4个) → 内置7工具
    → permission → session → prompt → loop → compaction → skills → commands
    → init → pluginsLoader → router → (extra plugins)
```

按依赖关系加载配置的 LLM 提供商（有 OPENAI_API_KEY 就挂 OpenAI 适配器，有 ANTHROPIC_API_KEY 就挂 Anthropic 适配器），**一个 key 都没有启动即抛错**（通用检查：`llm.providers().length === 0`）。

### 配置合并（`host/config.ts`）

配置来源从低到高合并：

1. `~/.flavorlite/config.json`（用户全局）
2. `.flavorlite/flavor.json`（项目）
3. 环境变量 / `.env`（内置极简 .env 加载器，不覆盖已有环境变量）
4. CLI 参数

配置用 `zod` 校验，非法配置启动即抛错。环境变量命名：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `FLAVOR_OPENAI_MODEL`、`ANTHROPIC_API_KEY`、`FLAVOR_MODEL`、`FLAVOR_MODE`。

### 两种运行模式（`cli.ts` + `host/repl.ts`）

- **交互式 REPL**：`flavor-lite`。`›` 提示符；运行中输入文字 = steering；`Ctrl+C` 中止当前 turn；斜杠命令；退出时保存会话
- **一次性运行**：`flavor-lite -p "任务"`。跑完就退出

### 【新】REPL 命令补全（`host/completions.ts`）

宿主拥有终端，插件拥有候选来源：插件通过 `repl` 服务注册 `CompletionProvider`。输入时宿主在输入行下方渲染匹配候选（前缀高亮），Tab 补全选中的候选，再按 Tab 循环。

实现细节很讲究：
- 渲染用原生 ANSI 且保持 readline 的光标模型完好——每次绘制后把终端光标恢复到输入行尾
- 行首 `prependListener` 在 readline 处理 Enter/Ctrl+C **之前**先撤掉建议块，命令输出永远不会和残留的建议块碰撞
- 输入行即将换行时退化为不渲染（防止 readline 多行重绘与建议块互相踩踏）
- 支持中英文宽度计算（`stringWidth`）、ANSI 安全截断、合并组合字符

### 【新】渲染可委托（`host/render.ts` + flavor-ui）

`render.ts` 检查可选的 `ui` 服务：存在就用它渲染（事件流、回显、错误、banner 全部委托），否则回退默认渲染。这就是 flavor-ui 能整体接管终端观感的机制。

### 终端交互与权限（`host/interaction.ts`）

终端交互实现（权限确认），在无 TTY / 一次性模式下优雅降级。

---

## 九、测试情况

`npm test` 实测 **19 个测试文件、238 个用例**（约 9.4s）：

| 文件 | 覆盖内容 |
|---|---|
| `kernel.test.ts` | 依赖排序、缺失服务报错、重复提供报错、成环报错、provide 回滚、效果逆序卸载、瀑布短路 |
| `loop.test.ts` | 完整一轮工具循环、steering 注入、迭代上限、中止占位、模型引用解析 |
| `permission.test.ts` | plan 模式拦截、危险命令硬拦截、bypass 放行、fail closed、一次性批准记忆、路径穿越拒绝 |
| `session.test.ts` | JSONL 持久化、列表排序、损坏行隔离、latest、非法 id 拒绝 |
| `compaction.test.ts` | 阈值内不动、尾部保留+标记、绝不以工具结果开头 |
| `history.test.ts` | sanitizeHistory 各种边界（完整组、悬空组、部分回答、孤儿结果） |
| `prompt.test.ts` | 空装配、节顺序、缺插件丢节、同名去重、权限/环境节 |
| `providers.test.ts` | 【新】提供商插件：无凭证跳过、有凭证自注册、dispose 注销、无提供商 fail loud、第三方 provider 计入 |
| `plugins.test.ts` | 【新】磁盘加载器：有效插件加载、manifest 校验、动态插件、依赖递归装载、热重载、坏插件不炸宿主 |
| `router.test.ts` | 【新】路由：L0 关键词召回、L1 倒排索引、L2 工具名回退、反馈记忆、空闲弹出、CJK 分词/指纹 |
| `completions.test.ts` | 【新】stringWidth/truncateToWidth/findHighlight、command-hints 候选收集、ReplCompletions 渲染/Tab 循环/Enter 撤块 |
| `memory-plugin.test.ts` | 【新】存储去重、热度老化、BM25/向量/RRF 检索、embedding 客户端、向量库、自动提取、崩溃安全 |
| `error-monitor-plugin.test.ts` | 【新】错误记录去重、分类、教训注入、ignorePatterns、脱敏、memory 集成、无 llm 时不写记忆 |
| `error-monitor-llm.test.ts` | 【新】LLM 分析：提示词构建、严格 JSON 解析、超时中止、重试、空回复重试、集成链路 |
| `websearch-plugin.test.ts` | 【新】HTML 解析、三提供商解析、searchWeb mock fetch、集成 |
| `subagent.test.ts` | 【新】子代理加载、spawn 独立会话、深度限制 |
| `filediff.test.ts` | 【新】新增/修改/覆盖/删除的 diff 输出、只读工具不输出、写失败不输出 |
| `flavor-ui.test.ts` | 【新】时间线渲染、spinner 动画、样式切换、banner、非 TTY 退化 |
| `clear-context-plugin.test.ts` | 【新】/clear 加载、会话文件重写、请求时裁剪、短历史不裁 |

> 当前有 4 个用例失败（`completions.test.ts` 3 个 + `websearch-plugin.test.ts` 1 个，均与磁盘插件集成测试相关），其余 234 个全部通过。本次仅更新报告，未对失败用例做修复。

测试风格很有特点：**用一个脚本化假模型适配器**（`scriptedAdapter`）回放预写的事件序列，捕获每个请求，从而无网络地测整个 agent 循环；磁盘插件测试则把插件目录复制进临时工作区，用真加载器装载。

---

## 十、快速上手

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 配置 API Key
cp .env.example .env
# 编辑 .env，至少设置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY

# 4. 启动交互式 REPL
node dist/cli.js

# 或一次性任务
node dist/cli.js -p "add a README section about testing"
```

用 OpenAI 兼容网关（DeepSeek、Moonshot、vLLM、Ollama 等）：

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
FLAVOR_OPENAI_MODEL=deepseek-chat
```

**装第三方插件**：往 `.flavorlite/plugins/<name>/` 放 `flavor-plugin.json` + `index.js`，然后 `/plugin reload`（或直接 `flavor-lite` 里 `/plugin new <name>` 生成脚手架）。本项目自带的 10 个插件就是现成的参考实现。

---

## 十一、给想扩展它的人

**想写一个磁盘插件？** 读 `docs/plugin-dev.md`（插件开发规范，唯一权威文档）。在 REPL 里 `/plugin new my-plugin` 生成脚手架，编辑 `index.js`，`/plugin reload my-plugin` 热重载——不需要重新构建、不需要重启。

**想加一个新工具？** `ctx.get("tools").register(...)` 即可；工具跑完后想立刻给终端打印点东西（比如 diff），挂 `tools/after-call`。

**想加一个新模型提供商？** 实现 `ModelAdapter`（一个 `stream(request)` 方法），仿照 `providers.ts` 写一个自我注册的 provider 插件。

**想加一条全局策略？** 挂一个 `tools/before-call` 或 `loop/before-request` 瀑布钩子，完全不碰循环代码。

**想自定义系统提示词？** 挂 `prompt/assemble` 钩子，往 `event.sections` 推一节即可。

**想让插件"用时才加载"？** manifest 里 `"activation": "dynamic"` + `triggers`，路由插件会按需召回、用后弹出。

**想定制整套插件栈？** 不用 `createAgent()`，直接用 `Runtime.create().use(...).start()` 自己搭。

---

## 十二、总结

flavor-lite 的价值不在于功能多，而在于**架构的纯粹性**：一个 150 行的内核 + 一堆各管一摊的小插件，通过"服务注册、瀑布钩子、可逆效果、拓扑排序"四个机制组合成完整智能体。系统提示词是拼出来的、权限是挂出来的、压缩是钩上去的、连主循环本身都是插件。想要什么能力，挂一个插件；不想要，卸掉即可。这种设计让代码小而清晰，也让扩展变得极其便宜。

8-15 到 8-17 这一轮演进把"万物皆插件"推到了最后一步：**内核本身更薄了**（瀑布总线、提供商发现都插件化），**扩展成本降到了"放一个目录"**（磁盘插件 + 热重载 + 脚手架 + 开发规范文档），**复杂功能全搬到了插件层**（记忆、错误监控、网络搜索、子代理、代码图谱、UI、diff、规划……），甚至还有了**按需加载**（dynamic 插件 + 路由召回 + 空闲弹出），让"插件多"不再等于"内存多、提示词大"。如果你愿意，这个内核已经可以当作一个通用 agent 平台来用了。
