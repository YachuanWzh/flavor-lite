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
| 信号感知 | ✅ 已增强 | `loop/after-run` 载荷扩展为 `{ iterations, reason, toolCalls, toolErrors, steers, inputTokens, outputTokens }`；error-monitor / memory / router-memory.json 继续积累 |
| 生成知识 | 🟡 半自动 | `.flavorlite/skills/create-flavor-plugin/` 技能已教会模型写插件；`/plugin new` 脚手架 |
| 反思 | ✅ 已落地 | evolve 插件消费扩展后的 after-run 载荷，reflections 记录真实统计与 signalDelta |
| 验证 | ✅ 已落地 | `loader.verify()` 影子 Runtime 沙箱冒烟（`/plugin verify`、`/evolve verify`）；`/evolve test` 跑套件 |
| 版本/回滚 | ✅ 已落地 | 每次成功激活快照至 `.versions/<name>/`（留 5 份），`/plugin revert`、`/evolve revert` 恢复最后良好版本 |

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

**已落地统一 telemetry**（`src/plugins/telemetry/index.ts`）：内置插件提供
`telemetry` 服务，所有信号汇入单一 JSONL 流（`.flavorlite/telemetry.jsonl`）：
`tool.call` / `tool.blocked`（挂 tools/after-call 与 prepend 的 tools/before-call）、
`run.end`（loop/after-run 全量载荷）、router 的 `router.recall` / `router.feedback`。
`record()` 同步 fire-and-forget 永不抛错；滚动上限 5000 条；`/telemetry stats|show|clear`
提供 24h 聚合视图。router-memory.json 等专职状态文件继续存在，但反思/治理插件
从此有一个共享的只读信号面（`events(query)`）。

**已落地的信号联动**（批次二）：evolve 直接读 error-monitor/records.json，
将高置信度（≥ emConfidence，默认 0.7）LLM 分析记录并入 `/evolve suggest` 与
`evolve_improve` 建议池（id 前缀 `em:`，复用 done.json 关闭），error-monitor 插件零改动。

#### 3.6 memory → skill → plugin 晋升阶梯

三种知识形态已存在但没有流动。做一个反思插件（挂 `session/end`）：

- 同类 pitfall 在 memory 中出现 ≥3 次 → 提议固化为 skill；
- skill 中反复出现"手写类似代码"的模式 → 提议生成插件。

这是自进化最有复利的部分：每次进化都让下一次任务更便宜。

**已落地 skill 层阶梯**（批次二）：skill-distiller 蒸馏 generated 技能
（`loop/after-run` 门控 + LLM 严格 JSON 契约 + 配额上限）；`/distill promote <slug>`
是人工闸门，把 generated 技能晋升为 curated（front-matter `generated: false` +
`promoted: true`），晋升后脱离生成配额、免于 `/distill rm`。

**已落地两段提议与转化**（批次三，knowledge-promoter 插件，spec 见
docs/specs/knowledge-promoter.md）：

- memory → skill：memory `references()` 按 topicKey 分组，同主题 ≥3 条即提议；
  `/ladder to-skill <topic>` 用记忆 summary 合成 SKILL.md 草稿
  （`generated: true` + `promotedFrom: memory`，纳入 /distill 管理面）。
- skill → plugin：每个 finished run 扫描 transcript 统计技能提及（每 run 每技能
  最多 +1），使用度 ≥3 且无同名插件即提议；`/ladder to-plugin <slug>` 脚手架
  插件 + PLAN.md（技能正文 + verify/reload/test 步骤）。提议经 prompt section
  与 `/ladder` 可见，done.json 防重复，全程无 LLM 依赖。

#### 3.7 triggers 自动维护

自产插件的"作者"（模型自己）写的 keywords 往往不准。router-memory.json 里已有
召回失败的 fp 数据，只差一个消费者把它回写进 manifest 的 `triggers` ——
等于让插件自己学会"什么请求该叫我"。

**已落地**（批次二）：`/evolve learn` 读 router-memory.json，按插件计 token 净得分
（used:true +1 / used:false -1），得分 ≥1 的 token 合并进对应 manifest 的
`triggers.keywords`（去重、上限 16、幂等），L0 确定性召回随之变准。

### 第三梯队：治理与安全

#### 3.8 自产插件的能力分级（✅ 已落地）

manifest 声明 `capabilities`（shell / 网络 / 写宿主文件等），permission 引擎对
`origin: "generated"` 的插件默认收紧（如生成的 shell 工具强制 ask）。
现有四模式权限引擎挂 `tools/before-call` 即可实现，无需动内核。
更重的选项是 worker_threads 沙箱隔离，非必要不引入。

**落地形态**：loader 在挂载时按工具注册 diff 追踪归属（`ownerOfTool`），
`PluginStatus` 暴露 `origin/generatedFrom/capabilities`（`/plugin list` 显示
`[generated]` 徽标与 capabilities）；permission 在 `tools/before-call` 执行
manifest 契约——shell/write 类工具未声明对应 capability 在任何模式（含 bypass）
直接拒绝，已声明则每 plugin+capability+路径作用域强制 ask 一次；
read/control 不设卡，network/host 仅声明展示。脚手架（`/evolve improve`、
`/ladder to-plugin`）输出中已带 capabilities 声明指引。

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

## 5. 最小起步：三件事先跑通循环（✅ 均已落地）

1. **evolve 元插件**（loader 能力工具化）—— 打通模型的手；
2. **loader.verify() 沙箱冒烟** —— 建立免疫系统（影子 Runtime + 依赖 stub，激活前干跑）；
3. **`loop/after-run` 载荷扩展** —— 给反思供料（reflections 记录 toolCalls/toolErrors/steers/tokens 与真实 signalDelta）。

加固项也已跟进：每次成功激活自动快照，`/plugin revert` / `/evolve revert` 一键回滚。

三者合起来即最小可运行的自进化循环：

```
会话结束 → 反思发现重复模式 → 生成插件 → 沙箱验证 → 热激活 → 测试验证 → router 反馈决定去留
```

其余（晋升阶梯、triggers 回写、能力分级、session/end hook）均为循环跑通后的加固项。

## 6. 批次二加固（✅ 已落地，spec 见 docs/specs/evolve-batch2.md）

1. **SFT 导出**：`/evolve export [limit]` 将干净会话轨迹（去 steering/system
   meta、≥4 条消息、单条截断 20k）覆盖写 `.flavorlite/evolve/sft.jsonl`，
   供蒸馏/微调管道直接消费；
2. **技能晋升阶梯**：`/distill promote <slug>`（见 3.6）；
3. **triggers 回写**：`/evolve learn`（见 3.7）；
4. **信号联动**：evolve 消费 error-monitor 高置信度分析（见 3.5）。

进化预算熔断（3.9）、manifest provenance（origin/generatedFrom）、统一
telemetry 服务、自产插件能力分级（3.8）均已落地。

## 7. 批次三：晋升阶梯全通（✅ 已落地，spec 见 docs/specs/knowledge-promoter.md）

新插件 `knowledge-promoter`（eager、无 LLM 依赖）补齐 3.6 剩余两段：
memory→skill 提议与 `/ladder to-skill` 转化、skill→plugin 使用度追踪与
`/ladder to-plugin` 转化。至此三层知识形态（memory/skill/plugin）全链路可流动：

```
memory 积累 → /ladder to-skill → SKILL.md 草稿 → /distill promote → curated 技能
技能反复使用 → /ladder to-plugin → 脚手架+PLAN.md → verify/reload/test → 新能力
```

## 8. 批次四：信号合一与能力分级（✅ 已落地）

1. **统一 telemetry 服务**（见 3.5）：单一 JSONL 信号流 + `/telemetry` 聚合命令，
   router 的召回/反馈同步写入；
2. **自产插件能力分级**（见 3.8）：origin 字段消费落地——loader 工具归属追踪 +
   permission manifest 契约门禁（未声明即拒、已声明强 ask）。

进化预算与熔断（3.9）现已落地：每日候选/验证上限持久化到
`.flavorlite/evolve/budget.json`，连续失败触发熔断，`/evolve budget` 可审计，
`/evolve resume` 由操作者恢复。候选插件先进入 `candidate`，回归或验证失败进入
`quarantined`，只有 canary 接受后转为 `active`。

## 9. 批次五：有界自治与资产治理（✅ 已落地）

1. **规则衰减与配额**：长期无帮助的规则过期，规则总数受限；有正反馈的规则保留。
2. **候选生命周期**：自产插件严格走 candidate → active/quarantined，不会自动加载未验收代码。
3. **资产治理**：`asset-governance` 按使用与反馈精度隔离低价值 generated skill/plugin，
   `/governance status|sweep|restore` 保留人工复活通道。
4. **信号投影**：telemetry reducer 从版本化、脱敏事件流重建运行、工具、错误、阻断与
   插件反馈统计，治理决策不依赖脆弱的临时内存。

## 附：相关现有资产索引

| 资产 | 位置 | 在自进化中的角色 |
|---|---|---|
| pluginsLoader | `src/plugins/plugins/index.ts` | 部署层：发现/热重载/watch/隔离 |
| router | `src/plugins/router/index.ts` | 选择层：三级召回 + 反馈降权封顶 + 空闲 eject |
| hooks 总线 | `src/plugins/hooks/index.ts` | 全部进化行为的接缝载体 |
| permission | `src/plugins/permission/index.ts` | 治理层：自产插件能力收紧的执行点 |
| telemetry | `src/plugins/telemetry/index.ts` | 信号层：统一 JSONL 信号流（工具/运行/路由） |
| create-flavor-plugin | `.flavorlite/skills/create-flavor-plugin/SKILL.md` | 生成层的知识基础（教模型写插件） |
| memory 插件 | `.flavorlite/plugins/memory/` | 声明式知识沉淀 + 会话后 LLM 提取 |
| error-monitor | `.flavorlite/plugins/error-monitor/` | 失败信号积累与分析 |
| plugin-dev 规范 | `docs/plugin-dev.md` | 插件契约权威文档 |
