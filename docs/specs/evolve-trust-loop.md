# 自进化可信闭环（v0.2）

本轮把自进化从“收集建议并创建脚手架”升级为可归因、可验证、可审计的状态机。

## 运行归因

`loop/after-run` 新增可选字段：

- `runId`：每次 `agent.run()` 的稳定 UUID；
- `sessionId`：本次运行实际使用的会话；
- `outcome`：`success | provider_error | max_iterations | aborted`；
- `successful`：仅 clean finish 且没有工具错误时为 true。

工具 before/after hook 同时携带 `context.runId/sessionId`。学习插件必须优先使用精确 ID，
不得在并发路径中依赖 `session.latest()`。

## Episode 状态机

每次 `evolve_improve` 或 `/evolve improve` 写入
`.flavorlite/evolve/episodes.json`：

`implemented -> verified -> canary -> accepted`

失败分支为 `rejected | rolled_back`。创建规则或插件只到 `implemented`；
`/evolve test <suggestionId>` 依次运行 focused regression（若有）、test、typecheck、build，
全部通过才进入 `verified`；`/evolve done` 只允许 verified episode 进入 canary。
默认需要 3 次真正调用受影响工具且没有同工具错误复发才自动 accepted；复发则 rejected 并重新开放建议。
无需修复的建议使用 `/evolve dismiss`，避免把“忽略”错误统计成“能力提升”。

## 信号与指标

- reflection 的 `signalDelta` 改为相邻 run 的工具失败率差值；负值现在真实表示改善；
- 建议按次数、时间排序；有 runId 时，重复阈值按跨 run 复发而非同一 run 重试计算；
- deliberate probe/expected failure 不进入建议池；
- Read/Grep/Glob/Shell/Write/Edit 等纯通用 trigram 不再提议为新工具；
- pattern 记录工具参数键签名，但不记录参数值。

## 知识晋升

- skill 使用只由成功读取 `SKILL.md` 的 hook 计数，不再扫描 transcript 文本；
- skill distillation 只消费成功 run，使用精确 sessionId，并串行执行避免并发覆盖；
- 生成技能记录来源 run/session，front matter 单行清洗，正文必须具有程序结构；
- memory -> skill 会去重，并对混合 Windows/Unix 指引写出冲突警告；
- skill -> plugin 创建后处于 implemented，`/ladder accept <slug>` 验证通过才关闭提议。

## 路由学习与生成代码治理

- trigger 晋升默认要求 support >= 3 且 precision >= 0.75；
- 候选按精确率、支持度排序，学习项有独立审计账本，可淘汰退化 token；
- generated plugin 在进入宿主前扫描所有 JS 源码，禁止直接 host 模块、动态执行、
  process 控制和 ambient network；随后在只读权限子进程中预导入，支持超时终止；
- 生成插件的副作用必须经注入服务执行，才能受到 permission hook 治理。

## 验证命令

默认完整门禁：

1. `npm test`
2. `npm run typecheck`
3. `npm run build`

可通过 evolve manifest 的 `verificationCommands` 调整。
