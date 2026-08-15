# flavor-lite 项目探索报告

> 探索日期：2026-08-15
> 测试验证：`npm test` 全部通过（7 个测试文件 / 39 个测试用例）

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

---

## 二、技术栈与工程配置

| 项目 | 内容 |
|---|---|
| 语言 | TypeScript（strict 模式 + `noUncheckedIndexedAccess`） |
| 包管理器 | npm |
| Node 要求 | >= 20 |
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

---

## 三、目录结构

```
flavor-lite/
├── src/
│   ├── index.ts                  # 公共 SDK 出口：把内核和所有插件统一导出
│   ├── cli.ts                    # CLI 入口：解析参数 → createAgent → REPL 或一次性运行
│   ├── kernel/                   # 微型内核（mini-Cordis）
│   │   ├── types.ts              #   类型：Plugin、PluginContext、Logger、Waterfall 等
│   │   ├── context.ts            #   上下文：服务仓库 + 事件总线 + 可逆效果栈
│   │   ├── runtime.ts            #   运行时：挂载插件、拓扑排序、逆序卸载
│   │   └── index.ts              #   内核公共出口
│   ├── shared/
│   │   └── messages.ts           # 与厂商无关的消息模型 + 历史清洗
│   ├── plugins/                  # 所有能力都是插件
│   │   ├── llm/                  #   大模型能力缝：适配器注册表、OpenAI/Anthropic 适配器、SSE 解析
│   │   ├── tools/                #   工具能力缝：工具注册表 + before/after 钩子 + 7 个内置工具
│   │   ├── permission/           #   权限插件：4 种模式 + 危险命令硬拦截
│   │   ├── session/              #   会话插件：.flavor/sessions 下的 JSONL 持久化
│   │   ├── prompt/               #   提示词插件：纯装配器，只负责拼接各插件贡献的节
│   │   ├── guidance/             #   引导插件：身份/安全/任务/环境 四个提示词节
│   │   ├── loop/                 #   智能体循环插件：流式、steering、重试、压缩钩子
│   │   ├── compaction/           #   历史压缩插件：主动+被动裁剪上下文
│   │   ├── skills/               #   技能插件：SKILL.md 发现 → 提示词节
│   │   ├── commands/             #   斜杠命令注册表
│   │   └── init/                 #   项目指南插件：FLAVOR.md 注入 + /init 生成器
│   └── host/                     # 宿主层：装配、配置合并、终端交互、渲染、REPL
│       ├── bootstrap.ts          #   createAgent：唯一的组合根，挂载全部默认插件
│       ├── config.ts             #   多源配置合并（用户/项目/环境/CLI），zod 校验
│       ├── interaction.ts        #   终端交互实现（权限确认）
│       ├── render.ts             #   事件渲染：零依赖 ANSI 颜色
│       └── repl.ts               #   交互式 REPL
├── tests/                        # 7 个测试文件，39 个用例
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

这是 flavor-lite 最优雅的扩展点。一个钩子可以有多层监听器，像"洋葱"一样套在一起：每个监听器收到值，可以做点事，再调用 `next(value)` 传给下一层；**不调用 next 就是短路**。

```ts
ctx.hook("tools/before-call", async (event, next) => {
  console.log("工具要开始跑啦");
  const result = await next(event);   // 传给下一层
  console.log("工具跑完了");
  return result;
});
```

权限插件、压缩插件就是通过这种钩子"挂"到循环上，**完全不需要改动循环本身**——这就是"插件，而不是改循环"（plugins, not loop changes）。

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

- 每个会话是一个文件：`.flavor/sessions/<时间戳>-<随机数>.jsonl`
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

**卸掉某个插件，它的节就消失**——系统提示词完全由插件决定，这是"一切皆插件"最直观的体现。

### 6. 循环插件（`plugins/loop/`）——智能体的主循环

`agent` 服务实现 `run(options)` 异步事件流。一次 `run` 的流程：

```
用户输入 → 记录到会话
  ↓
进入 while 循环（最多 maxIterations=30 次）
  ↓
插入 steering 消息（运行中用户插话）→ loop/before-request 瀑布（压缩钩子）
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

### 8. 其他插件

- **skills**：扫描 `.flavor/skills/<name>/SKILL.md`（项目）和 `~/.flavor/skills/`（用户全局），只把技能的名字和描述注入提示词，模型用到时再用 Read 工具读全文——保持提示词精简
- **commands**：斜杠命令注册表，`/model`、`/permissions`、`/sessions`、`/resume`、`/new`、`/help` 由宿主注册，`/init` 由 init 插件注册
- **init**：FLAVOR.md 项目指南作为提示词节注入；`/init` 让 agent 自己探索项目并生成 `.flavor/FLAVOR.md`

---

## 七、宿主层与配置

### createAgent() —— 组合根（`host/bootstrap.ts`）

这是唯一知道完整插件清单的地方：

```
llm → tools → guidance(4个) → 内置7工具 → permission → session
    → prompt → loop → compaction → skills → commands → init
```

按依赖关系加载配置的 LLM 提供商（有 OPENAI_API_KEY 就挂 OpenAI 适配器，有 ANTHROPIC_API_KEY 就挂 Anthropic 适配器），**一个 key 都没有启动即抛错**。

### 配置合并（`host/config.ts`）

配置来源从低到高合并：

1. `~/.flavor/config.json`（用户全局）
2. `.flavor/flavor.json`（项目）
3. 环境变量 / `.env`（内置极简 .env 加载器，不覆盖已有环境变量）
4. CLI 参数

配置用 `zod` 校验，非法配置启动即抛错。环境变量命名：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `FLAVOR_OPENAI_MODEL`、`ANTHROPIC_API_KEY`、`FLAVOR_MODEL`、`FLAVOR_MODE`。

### 两种运行模式（`cli.ts` + `host/repl.ts`）

- **交互式 REPL**：`flavor-lite`。`›` 提示符；运行中输入文字 = steering；`Ctrl+C` 中止当前 turn；斜杠命令；退出时保存会话
- **一次性运行**：`flavor-lite -p "任务"`。跑完就退出

### 终端渲染（`host/render.ts`）

零依赖 ANSI 颜色，非 TTY 或设置 `NO_COLOR` 时自动退化为纯文本。文本增量直接写 stdout（实时流式），工具调用显示 `⚙ 工具名 参数摘要`。

---

## 八、测试情况

`npm test` 实测 **7 个测试文件、39 个用例全部通过**（722ms）：

| 文件 | 覆盖内容 |
|---|---|
| `kernel.test.ts` | 依赖排序、缺失服务报错、重复提供报错、成环报错、provide 回滚、效果逆序卸载、瀑布短路 |
| `loop.test.ts` | 完整一轮工具循环、steering 注入、迭代上限、中止占位、模型引用解析 |
| `permission.test.ts` | plan 模式拦截、危险命令硬拦截、bypass 放行、fail closed、一次性批准记忆、路径穿越拒绝 |
| `session.test.ts` | JSONL 持久化、列表排序、损坏行隔离、latest、非法 id 拒绝 |
| `compaction.test.ts` | 阈值内不动、尾部保留+标记、绝不以工具结果开头 |
| `history.test.ts` | sanitizeHistory 各种边界（完整组、悬空组、部分回答、孤儿结果） |
| `prompt.test.ts` | 空装配、节顺序、缺插件丢节、同名去重、权限/环境节 |

测试风格很有特点：**用一个脚本化假模型适配器**（`scriptedAdapter`）回放预写的事件序列，捕获每个请求，从而无网络地测整个 agent 循环。

---

## 九、快速上手

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

---

## 十、给想扩展它的人

**想加一个新工具？** 写一个工具对象，在插件 `apply` 里 `ctx.get("tools").register(...)` 即可。

**想加一个新模型提供商？** 实现 `ModelAdapter`（一个 `stream(request)` 方法），注册进 `llm` 适配器注册表。

**想加一条全局策略？** 挂一个 `tools/before-call` 或 `loop/before-request` 瀑布钩子，完全不碰循环代码。

**想自定义系统提示词？** 挂 `prompt/assemble` 钩子，往 `event.sections` 推一节即可。

**想定制整套插件栈？** 不用 `createAgent()`，直接用 `Runtime.create().use(...).start()` 自己搭。

---

## 十一、总结

flavor-lite 的价值不在于功能多，而在于**架构的纯粹性**：一个 150 行的内核 + 一堆各管一摊的小插件，通过"服务注册、瀑布钩子、可逆效果、拓扑排序"四个机制组合成完整智能体。系统提示词是拼出来的、权限是挂出来的、压缩是钩上去的、连主循环本身都是插件。想要什么能力，挂一个插件；不想要，卸掉即可。这种设计让代码小而清晰，也让扩展变得极其便宜。
