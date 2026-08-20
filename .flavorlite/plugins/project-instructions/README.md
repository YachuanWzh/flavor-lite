# project-instructions

发现并应用其他 coding-agent 生态中的仓库说明文件，同时保留 Flavor Lite 原生 `FLAVOR.md` 行为。支持 `AGENTS.md`、`CLAUDE.md` 和 `.cursorrules`。

插件 eager 加载并提供 `projectInstructions` 服务。根级说明自动进入系统 prompt；嵌套说明只对其目录子树生效。

## Tool

| 名称 | 类别 | 用途 |
|---|---|---|
| `project_instructions` | `read` | 返回适用于指定 `path` 的 root-to-leaf 说明；`refresh` 可刷新缓存 |

```json
{ "path": "packages/web/src/App.tsx", "refresh": true }
```

扫描会忽略 `.git`、依赖目录、构建产物和 `.flavorlite` 数据目录；结果按路径确定性排序，每段内容都带来源文件名。工作区外路径会被拒绝，无法读取的文件会跳过而不会中断 agent。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `maxFiles` | `50` | 最多读取的说明文件数 |
| `maxChars` | `30000` | 注入/返回内容的字符预算 |

开发验证：`node --test .flavorlite/plugins/project-instructions/index.test.mjs`。
