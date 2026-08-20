# verification-gate

为 agent 提供一个确定性的项目验证入口：自动识别仓库已有的 typecheck、lint、test、build 命令，顺序执行并返回带退出码和耗时的报告。

插件 eager 加载。成功的 `write` 工具调用会记录受影响路径，用于 quick 模式选择更聚焦的测试。

## Tool and command

| 名称 | 类别 | 用途 |
|---|---|---|
| `verify_changes` | `shell` | `mode=quick|full` 执行项目原生检查 |
| `/verify quick` | command | 运行快速验证 |
| `/verify full` | command | 运行完整验证 |

检测规则：

- npm：只运行 `package.json` 中实际存在的 `typecheck`、`lint`、`test`、`build` scripts。
- Python：`python -m pytest`。
- Go：`go test ./...`。
- Rust：`cargo check`，full 模式额外运行 `cargo test`。

quick 优先执行类型/静态检查和已修改测试；full 包含完整 test/build。未检测到检查项时返回明确的成功 no-op。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `timeoutMs` | `120000` | 每个命令超时 |
| `maxOutputChars` | `20000` | 捕获输出上限 |
| `stopOnFailure` | `true` | 首个失败后停止 |
| `commands` | 未设置 | 可选的管理员预配置命令列表 |

模型不能通过工具参数注入任意 shell 命令；命令只来自仓库元数据或 manifest 配置。所有异常都会转换为 `isError`。开发验证：`node --test .flavorlite/plugins/verification-gate/index.test.mjs`。
