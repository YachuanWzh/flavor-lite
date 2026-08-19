# knowledge-promoter：memory→skill 与 skill→plugin 晋升阶梯

> 对应 docs/evolve.md 路线图 3.6 剩余两段。批次二已落地 skill 层人工闸门
> （/distill promote）；本批次补齐阶梯的"提议与转化"两端。
> 全部在 `.flavorlite/plugins` 内实现，内核零改动。SDD（本文档）+ TDD。

## 动机

三种知识形态（memory 声明式 / skill 程序式 / plugin 可执行）已存在但没有流动：

- 同一主题的 pitfall 在长期记忆里反复积累，却只能逐条被检索；
- 一个被反复使用的 skill 意味着一段被反复人工执行的工作流，本可自动化为插件。

## 设计

新插件 `knowledge-promoter`（eager，无 LLM 依赖，确定性可测），
提供 `knowledgePromoter` 服务，注册 `/ladder` 命令，
存储位于 `.flavorlite/knowledge-promoter/{skill-usage.json, done.json}`。

### 1. memory → skill 提议

- 数据源：`ctx.tryGet("memory")?.store.references()`（可选服务，缺失则无此类提议）。
- 按 `topicKey` 分组；条目数 ≥ `config.memoryTopicThreshold`（默认 3）为主题候选。
- 跳过条件：已标记 done（`skill:<topicKey>`）、slug（slugify(topicKey)）已有同名技能。
- 转化命令 `/ladder to-skill <topicKey>`（人工门控）：
  - 用该主题全部条目的 summary 合成 `SKILL.md` 草稿，front-matter 含
    `generated: true` + `promotedFrom: memory` + `promotedAt`（因此自动纳入
    skill-distiller 的管理面：受配额保护、可 /distill promote 晋升、可 rm）；
  - slug 已存在 → 拒绝；成功后标记 done，提议消失。

### 2. skill → plugin 提议

- 使用度信号：`loop/after-run`（仅 `reason === "finished"`）读最新会话 transcript，
  对 `ctx.tryGet("skills")?.discover()` 的每个技能，若其 slug 或名称出现在
  user/assistant 消息文本中，则该 run 计一次使用（**每 run 每技能最多 +1**，
  与 evolve trigram 同策略，跨 run 累计才有意义），累计写 skill-usage.json。
- 计数 ≥ `config.skillUsageThreshold`（默认 3）且未 done（`plugin:<slug>`）、
  且 loader catalog 中尚无同名插件 → 提议。
- 转化命令 `/ladder to-plugin <slug>`（人工门控）：
  - 读技能正文，`pluginsLoader.scaffold(slug)` 脚手架插件目录，写 PLAN.md
    （技能正文 + 实现/verify/reload/test 步骤），标记 done；
  - 技能不存在 → 拒绝。

### 3. 提议可见性

- `prompt/assemble` 注入 `knowledge-promoter` section（仅当有开放提议，
  上限 `config.maxProposals` 默认 8 条），格式：
  `- (memory -> skill) topic "<t>" has N memories — /ladder to-skill <t>`
  `- (skill -> plugin) skill "<slug>" used N runs — /ladder to-plugin <slug>`
- `/ladder`（无参或 `suggest`）列出同样的提议明细；无提议时
  `no open proposals`。

## 测试计划（TDD，先红后绿）

`tests/knowledge-promoter.test.ts`（真实 loader 加载复制的插件目录，
memory/skills/session 用 definePlugin stub）：

1. 加载成功、`/ladder` 空时 `no open proposals`；
2. 同 topic 3 条 memory → prompt section 与 `/ladder` 均含提议；
   `/ladder to-skill` 生成含 `promotedFrom: memory` 的 SKILL.md 并关闭提议；
3. 不足阈值不提议；slug 已存在不提议；
4. transcript 提及技能，3 个 finished run → 使用度 3 → 提议；
   单个 run 内多次提及只计 1；
5. `/ladder to-plugin` 脚手架插件 + PLAN.md 含技能正文并关闭提议；未知 slug 拒绝；
6. 收尾：全量测试、build、loader.verify 冒烟。

## 验收标准

1. 两段阶梯"提议可见 + 人工命令转化 + done 防重复"闭环；
2. 生成技能复用 skill-distiller 管理面（generated/promote/rm 语义兼容）；
3. 内核零改动、全量测试绿。
