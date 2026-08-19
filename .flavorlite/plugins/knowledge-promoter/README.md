# knowledge-promoter

晋升阶梯插件：让知识在 memory → skill → plugin 三层之间向上流动
（docs/evolve.md 路线图 3.6，spec 见 docs/specs/knowledge-promoter.md）。

## 提议来源

- **memory → skill**：长期记忆按 `topicKey` 分组，同主题条目 ≥ 3（可配
  `memoryTopicThreshold`）即提议把该主题固化为技能。
- **skill → plugin**：每个 `finished` run 结束后扫描最新会话 transcript，
  提及某技能（slug 或名称）计一次使用（每 run 每技能最多 +1）；累计 ≥ 3
  （可配 `skillUsageThreshold`）即提议把该工作流自动化为插件。

提议经 `prompt/assemble` 的 `knowledge-promoter` section 与 `/ladder` 命令
可见；转化过的主题/技能记入 `done.json`，不再重复提议。

## 命令

- `/ladder` — 列出开放提议；
- `/ladder to-skill <topicKey>` — 用该主题的记忆 summary 合成 SKILL.md 草稿
  （`generated: true` + `promotedFrom: memory`，纳入 /distill 管理面）；
- `/ladder to-plugin <slug>` — 脚手架插件目录并写 PLAN.md（含技能正文与
  verify/reload/test 步骤）。

## 观测面

`.flavorlite/knowledge-promoter/skill-usage.json`（技能使用计数）、
`done.json`（已转化标记）。全程无 LLM 依赖，确定性可测。
