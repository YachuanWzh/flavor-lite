# astgraph

为 agent 构建本地代码图谱，用符号、调用、import 和继承关系进行精确导航，减少大范围 grep/read。索引存储在 `.flavorlite/astgraph/index.db`。

插件为 dynamic activation，首次调用相关工具或命令时加载。需要 Node.js 22.5+ 的 `node:sqlite`；较旧版本会得到友好错误，不会阻止其他插件启动。

## Tools

| 名称 | 类别 | 用途 |
|---|---|---|
| `ast_search` | `read` | 按关键字搜索符号锚点 |
| `ast_callers` | `read` | 查看谁调用/导入指定节点 |
| `ast_callees` | `read` | 查看指定节点调用/导入了谁 |
| `ast_impact` | `read` | 计算多跳修改影响范围 |
| `ast_context` | `read` | 返回锚点周围精确的文件和行区间 |

## Command

```text
/ast init
/ast sync [path...]
/ast status
/ast search <query>
/ast callers <node-id>
/ast callees <node-id>
/ast impact <node-id> [--hops N] [--direction up|down|both]
/ast context <node-id> [--hops N]
```

节点 ID 形如 `src/order.ts#cancelOrder`。首次使用先运行 `/ast init`；成功的文件写入后插件会异步增量同步索引。当前解析重点覆盖 JS/TS 系列文件，数据库采用 WAL 模式。

索引是可重建的派生数据，不会修改源码。卸载时注销工具、命令和 hook。插件包含本地 vendor 解析资源，不需要网络服务。
