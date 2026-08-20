# git-safety

为 agent 提供结构化 Git 检查和可恢复的文件内容检查点。它用于保护用户在 agent 开始工作前已经存在的修改，不依赖 `git reset`、`checkout` 或 `stash`。

插件 eager 加载，需要工作区位于 Git 仓库中。

## Tools and command

| 名称 | 类别 | 用途 |
|---|---|---|
| `git_status` | `read` | 读取 porcelain 工作区状态 |
| `git_diff` | `read` | 查看 unstaged/staged diff，可限制到路径 |
| `git_blame` | `read` | 查看文件或行区间 blame |
| `git_checkpoint` | `write` | 保存当前 changed/untracked 文件内容 |
| `git_restore_checkpoint` | `write` | 恢复指定检查点，会覆盖其后的文件修改 |
| `git_checkpoint_list` | `read` | 列出检查点 |
| `/checkpoints` | command | 面向用户列出检查点 |

```text
/checkpoints
```

检查点写入 `.flavorlite/git-safety/checkpoints/*.json`，包含创建时的 HEAD、文件存在状态和内容。HEAD 已变化时恢复默认拒绝执行；只有显式传入 `allowHeadChange: true` 才会继续。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `maxFiles` | `500` | 单个检查点最大文件数 |
| `maxBytes` | `10485760` | 单个检查点最大内容字节数 |

插件从不 commit、stash、reset、checkout 或切换分支。开发验证：`node --test .flavorlite/plugins/git-safety/index.test.mjs`。
