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
| `/evolve suggest` | 查看达到阈值的改进建议 |
| `/evolve improve <id>` | 为建议生成修复插件脚手架 |
| `/evolve verify <plugin>` | 沙箱 dry-run 验证候选插件 |
| `/evolve revert <plugin>` | 恢复插件上一可用版本 |
| `/evolve test` | 运行配置的测试命令 |
| `/evolve done <id>` | 标记建议已处理 |
| `/evolve learn` | 把已确认的路由触发词写回插件 manifest |
| `/evolve export [count]` | 导出有界的干净会话轨迹 |
| `/evolve clear` | 清理 signals、patterns 和 done markers |

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `promptTop` | `3` | 注入 prompt 的建议数量 |
| `minRepeats` | `2` | 失败达到建议阈值的次数 |
| `testCommand` | `npm test` | 候选修复验证命令 |
| `testTimeoutMs` | `120000` | 验证超时 |

安全边界：只处理达到阈值的 suggestion；生成内容受插件目录治理；验证成功前不应启用候选；任何修改仍受普通 write 权限控制。卸载时所有服务、hook、工具和命令都会撤销。
