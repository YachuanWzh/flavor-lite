# evolve

受约束的插件级自我改进循环：记录重复工具失败和重复成功调用序列，形成 suggestion，由用户或 agent 选择是否生成修复插件或沉淀 prompt rule，并用测试验证。

插件 eager 加载，提供 `evolve` 服务。数据写入 `.flavorlite/evolve/`；生成修复使用插件加载器的 scaffold 能力，manifest 会标记 `origin: generated`。

## Tool

| 名称 | 类别 | 用途 |
|---|---|---|
| `evolve_improve` | `write` | 对 suggestion 生成插件脚手架，或以 `kind=prompt_rule` 写入规则 |

必填参数为 `suggestionId` 与 `implementation`。生成插件只创建带 `PLAN.md` 的候选目录，不会自动认为修复有效。

## Command

| 命令 | 用途 |
|---|---|
| `/evolve signals` | 查看捕获的失败信号 |
| `/evolve suggest` | 查看达到阈值的改进建议(失败、成功 trigram、error-monitor 分析) |
| `/evolve episodes` | 查看可信进化 episode 及其状态 |
| `/evolve improve <id>` | 为建议生成修复插件脚手架 |
| `/evolve baseline <id> <command>` | 为 episode 捕获失败基线(regression 必须先红) |
| `/evolve verify <plugin>` | 沙箱 dry-run 验证候选插件 |
| `/evolve revert <plugin>` | 恢复插件上一可用版本 |
| `/evolve test [id]` | 运行聚焦回归 + test/typecheck/build;标记 episode 已验证 |
| `/evolve done <id>` | 标记建议已处理(接受已验证 episode) |
| `/evolve dismiss <id>` | 关闭建议但不处理(支持 `em:` 记录) |
| `/evolve export [limit]` | 导出有界的干净会话轨迹到 `.flavorlite/evolve/sft.jsonl` |
| `/evolve learn` | 把已确认的路由触发词写回插件 manifest |
| `/evolve clear` | 清理 signals、patterns 和 done markers |

生命周期:`improve` → `baseline` → `verify`/`reload` → `test` → `done`,episode 会经历
`implemented → verified → canary → accepted`;验证失败或 canary 回归会拒收并回退。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `promptTop` | `3` | 注入 prompt 的建议数量 |
| `minRepeats` | `2` | 失败达到建议阈值的次数 |
| `patternThreshold` | `3` | 成功 trigram 达到工具提议阈值的次数 |
| `patternTop` | `2` | 注入 prompt 的 trigram 提议数量 |
| `testCommand` | `npm test` | 候选修复验证命令 |
| `testTimeoutMs` | `120000` | 验证超时 |
| `verificationCommands` | `[testCommand, npm run typecheck, npm run build]` | `/evolve test` 依次运行的验证命令组 |
| `canaryRuns` | `3` | episode 验收所需的干净 canary 运行次数 |
| `emConfidence` | `0.7` | error-monitor 分析进入建议池的最低置信度 |
| `exportLimit` | `20` | `/evolve export` 默认导出上限 |
| `learnMinSupport` | `3` | `/evolve learn` 触发词候选的最小支持度 |
| `learnMinPrecision` | `0.75` | `/evolve learn` 触发词候选的最小精度 |

安全边界：只处理达到阈值的 suggestion；生成内容受插件目录治理；验证成功前不应启用候选；任何修改仍受普通 write 权限控制。卸载时所有服务、hook、工具和命令都会撤销。
