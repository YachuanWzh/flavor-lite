# flavor-lite 插件模式自进化路线图

> 探索目标：在不破坏"微内核 + 一切皆插件"哲学的前提下，让 agent 依赖插件模式实现自进化。
> 本文档为探索性沉淀：现状盘点 → 缺口分析 → 分优先级路线图 → 反模式清单。

## 1. 视角：自进化闭环

自进化的完整闭环是：

```
感知信号 → 反思 → 生成 → 验证 → 部署 → 评估 → 选择/淘汰
   ↑_______________________________________________|
```

"进化"的对象按重量递增分三层：

1. **声明式知识**：memory（持久事实）、router 反馈（路由分数）
2. **程序式知识**：skills（SKILL.md 工作流指南）
3. **可执行能力**：plugins（工具 / 命令 / prompt section / hook / provider）

flavor-lite 的独特资产是第三层的**热加载部署能力**——磁盘发现、热重载、坏插件隔离
（`src/plugins/plugins/index.ts`），这让"生成插件 → 落盘 → 立即生效"天然可行，
是自进化最强的基础设施。

## 2. 现状盘点

| 闭环环节 | 现状 | 载体 |
|---|---|---|
| 部署 | ✅ 成熟 | pluginsLoader：磁盘发现、热重载、watch 同步、error 隔离、依赖拓扑、eager/dynamic 激活 |
| 评估/选择 | 🟡 部分 | router：指纹反馈 boost/penalty + 空闲 eject —— 只调**路由分数**，不触碰插件本体 |
| 信号感知 | 🟡 零散 | error-monitor 记录错误、memory 插件会话后提取持久事实、router-memory.json |
| 生成知识 | 🟡 半自动 | `.flavorlite/skills/create-flavor-plugin/` 技能已教会模型写插件；`/plugin new` 脚手架 |
| 反思 | 🟡 薄弱 | `loop/after-run` 载荷仅 `{ iterations, reason }`，反思插件拿不到足够素材 |
| 验证 | ❌ 缺失 | 模型写出的插件落盘即激活，没有免疫系统 |
| 版本/回滚 | ❌ 缺失 | reload 直接覆盖，坏了只能人工修 |

**结论**：部署层是这套架构最强的资产；自进化最大的短板在
"生成之后、激活之前"的中间地带，以及反馈信号的质量。

## 3. 路线图

### 第一梯队：闭环缺口（不补齐就谈不上自进化）

#### 3.1 Agent 侧的插件管理工具 —— 给模型一个"手"

现状：`/plugin new | reload | eject` 全是 REPL 人类命令；模型只能靠 Write 工具盲写文件，
且无法主动触发 reload。

做法：实现一个 `evolve` 元插件，把 `pluginsLoader` 的能力注册为**受权限约束的工具**
（scaffold / reload / list / eject），形成标准动作序列：

```
模型写代码 → 调 reload 工具 → 读 list 状态验证 loaded/error → 修复重试
```

成本最低、收益最直接的一步。error 状态里已有报错信息，只差把它喂回模型的管道。

#### 3.2 验证/评估 harness —— 自进化的免疫系统（最关键）

自产插件目前零验证直接进宿主。分三层：

1. **静态**：manifest schema + entry import 已有（失败进 error 状态）；可再加 lint 级检查
   （是否导出合法 Plugin 对象、disposer 是否存在）。
2. **沙箱冒烟**：给 loader 加 `verify(name)` 接口 —— 在影子 Runtime 上 dry-run 挂载，
   断言服务注册成功、注册的工具可调用，不碰真实宿主。
3. **约定式测试**：插件目录内可选 `test.js`，激活前自动跑。

有了这层，"模型生成 → 验证失败 → 带错误信息重试"才能成为可靠的迭代循环。

#### 3.3 信号增强 —— 反思插件的原料

内核接缝级小改动，决定上层反思插件能看到什么：

- 扩展 `LoopAfterRun` 载荷：工具调用次数/失败率、权限拒绝数、steering 次数、
  token 用量、错误摘要（当前仅 `{ iterations, reason }`）。
- 新增 `session/end` hook（带 transcript 指针）。
- loader 增加 `plugins/loaded` / `plugins/unloaded` 生命周期 hook。

均为几十行量级的接缝改动，符合 HookMap 声明合并的既有扩展方式。

#### 3.4 版本与回滚 + provenance

- loader 覆盖前保留上一版（如 `.flavorlite/plugins/.versions/<name>/`），
  激活失败或连续负反馈时自动 revert。
- manifest 增加 `origin: "user" | "generated"` 与 `generatedFrom: <session-id>`，
  让治理策略能区分人写与自产插件。

### 第二梯队：选择压力与知识晋升

#### 3.5 反馈信号从"用没用"升级为"有没有用"

router 目前只记录"召回后工具是否被调用"。更强的信号：

- `tools/after-call` 中的 `isError`（调用成功率）；
- 调用后用户是否 steering 纠偏；
- run 是否以 `finished` 收尾。

值得引入统一的 `metrics` / `telemetry` 服务（JSONL 追加），router、error-monitor、
evolve 插件共享消费——避免每个插件各自维护一份记忆文件
（当前已有 router-memory.json、error-monitor/records.json、memory/MEMORY.md 三份割裂信号源）。

#### 3.6 memory → skill → plugin 晋升阶梯

三种知识形态已存在但没有流动。做一个反思插件（挂 `session/end`）：

- 同类 pitfall 在 memory 中出现 ≥3 次 → 提议固化为 skill；
- skill 中反复出现"手写类似代码"的模式 → 提议生成插件。

这是自进化最有复利的部分：每次进化都让下一次任务更便宜。

#### 3.7 triggers 自动维护

自产插件的"作者"（模型自己）写的 keywords 往往不准。router-memory.json 里已有
召回失败的 fp 数据，只差一个消费者把它回写进 manifest 的 `triggers` ——
等于让插件自己学会"什么请求该叫我"。

### 第三梯队：治理与安全

#### 3.8 自产插件的能力分级

manifest 声明 `capabilities`（shell / 网络 / 写宿主文件等），permission 引擎对
`origin: "generated"` 的插件默认收紧（如生成的 shell 工具强制 ask）。
现有四模式权限引擎挂 `tools/before-call` 即可实现，无需动内核。
更重的选项是 worker_threads 沙箱隔离，非必要不引入。

#### 3.9 进化预算与熔断

- 反思/生成消耗 LLM 额度，需要频率与预算上限；
- 连续 N 个自产插件负反馈则暂停生成 —— router 已有的"降权封顶"决策
  （不彻底移除、留复活通道）同样适用于此。

## 4. 反模式清单（不要做的事）

- **不要在内核里加"进化调度器"**：反思、生成、验证全部做成插件消费 hook，
  bootstrap 保持纯挂载列表。
- **不要做模型微调式进化**：in-context 生成 + 磁盘文件 + 热重载已是甜点位。
- **不要让自进化绕过 fail-loud**：验证失败的插件宁可进 error 状态暴露，
  也不要静默降级激活。

## 5. 最小起步：三件事先跑通循环

1. **evolve 元插件**（loader 能力工具化）—— 打通模型的手；
2. **loader.verify() 沙箱冒烟** —— 建立免疫系统；
3. **`loop/after-run` 载荷扩展 + `session/end` hook** —— 给反思供料。

三者合起来即最小可运行的自进化循环：

```
会话结束 → 反思发现重复模式 → 生成插件 → 沙箱验证 → 热激活 → router 反馈决定去留
```

其余（回滚、晋升阶梯、能力分级）均为循环跑通后的加固项。

## 附：相关现有资产索引

| 资产 | 位置 | 在自进化中的角色 |
|---|---|---|
| pluginsLoader | `src/plugins/plugins/index.ts` | 部署层：发现/热重载/watch/隔离 |
| router | `src/plugins/router/index.ts` | 选择层：三级召回 + 反馈降权封顶 + 空闲 eject |
| hooks 总线 | `src/plugins/hooks/index.ts` | 全部进化行为的接缝载体 |
| permission | `src/plugins/permission/index.ts` | 治理层：自产插件能力收紧的执行点 |
| create-flavor-plugin | `.flavorlite/skills/create-flavor-plugin/SKILL.md` | 生成层的知识基础（教模型写插件） |
| memory 插件 | `.flavorlite/plugins/memory/` | 声明式知识沉淀 + 会话后 LLM 提取 |
| error-monitor | `.flavorlite/plugins/error-monitor/` | 失败信号积累与分析 |
| plugin-dev 规范 | `docs/plugin-dev.md` | 插件契约权威文档 |
