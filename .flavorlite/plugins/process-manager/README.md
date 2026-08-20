# process-manager

管理不会阻塞 agent tool call 的后台开发进程，例如 dev server、watcher 和本地服务。输出保存在有界环形缓冲区中，并通过 cursor 增量读取。

插件 eager 加载，提供 `processManager` 服务；Windows 子进程使用隐藏窗口且不接收交互式 stdin。

## Tools and command

| 名称 | 类别 | 用途 |
|---|---|---|
| `process_start` | `shell` | 启动命令并立即返回进程 ID |
| `process_poll` | `read` | 从 cursor 开始读取新增输出与状态 |
| `process_list` | `read` | 列出进程及 running/exited 状态 |
| `process_stop` | `shell` | 停止进程及其后代 |
| `/processes` | command | 查看后台进程摘要 |

典型流程：调用 `process_start`，保存返回的 ID；随后重复调用 `process_poll`，并把上次返回的 cursor 传入下一次调用；任务结束后调用 `process_stop`。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `maxProcesses` | `6` | 同时保留的最大进程数 |
| `maxOutputChars` | `100000` | 每个进程的日志字符上限 |

相同 live label 会被拒绝。卸载插件会停止所有仍在运行的进程。开发验证：`node --test .flavorlite/plugins/process-manager/index.test.mjs`。
