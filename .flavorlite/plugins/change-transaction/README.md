# change-transaction

为 coding agent 提供带前置条件的多文件原子修改。所有操作会先在内存中完成校验和暂存；任何路径、内容前置条件或落盘步骤失败，都不会留下只改了一半的工作区。

插件 eager 加载，仅依赖 Flavor Lite 的 `hooks` 与 `tools` 服务。

## Tool

| 名称 | 类别 | 用途 |
|---|---|---|
| `apply_patch_transaction` | `write` | 在一个事务中执行 `create`、`replace`、`delete` |

操作字段：

- `create`: `path`、`content`，目标必须不存在。
- `replace`: `path`、`oldText`、`newText`；默认要求 `oldText` 唯一，重复时需设置 `replaceAll: true`。
- `delete`: `path`，可选 `expectedText` 防止删除已被其他进程修改的文件。

```json
{
  "operations": [
    { "op": "replace", "path": "src/a.ts", "oldText": "old", "newText": "next" },
    { "op": "create", "path": "src/b.ts", "content": "export {};\n" }
  ]
}
```

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `maxOperations` | `50` | 单次事务最大操作数 |
| `maxStagedBytes` | `5242880` | 内存暂存文本总字节数上限 |

所有路径必须位于 workspace 内；失败结果以 `isError` 返回。插件不会 commit、stash 或调用 Git。

开发验证：`node --test .flavorlite/plugins/change-transaction/index.test.mjs`。
