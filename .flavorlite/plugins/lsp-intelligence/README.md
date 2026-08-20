# lsp-intelligence

通过标准 Language Server Protocol 给 agent 提供语义诊断、定义、引用、hover 和重命名能力。服务器按文件扩展名延迟启动，因此插件加载本身不会启动后台进程。

插件为 dynamic activation；第一次调用 `lsp_*` 工具或命中相关触发词时加载。

## Tools

| 名称 | 类别 | 用途 |
|---|---|---|
| `lsp_diagnostics` | `read` | 获取文件的语法/类型诊断 |
| `lsp_definition` | `read` | 查找指定位置的定义 |
| `lsp_references` | `read` | 查找指定位置的引用 |
| `lsp_hover` | `read` | 获取类型与文档信息 |
| `lsp_rename` | `write` | 通过 workspace edit 跨文件重命名 |

位置参数 `line`、`character` 使用 LSP 的零基坐标。`lsp_rename` 会拒绝重叠 edit、工作区外路径，并按逆序偏移应用修改。

## Language servers

默认候选：

- JavaScript/TypeScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`
- Rust: `rust-analyzer`
- Go: `gopls serve`
- C/C++: `clangd`

对应可执行文件需要已安装并位于 `PATH`。未安装时工具返回可操作的错误，不会让插件加载失败。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `requestTimeoutMs` | `10000` | 单次 LSP 请求超时 |
| `diagnosticWaitMs` | `500` | 打开文档后等待 diagnostics 的时间 |

卸载插件会向所有已启动服务器发送 shutdown/exit 并清理子进程。开发验证：`node --test .flavorlite/plugins/lsp-intelligence/index.test.mjs`。
