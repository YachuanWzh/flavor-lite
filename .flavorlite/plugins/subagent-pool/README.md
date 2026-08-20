# subagent-pool

把多个互相独立的任务交给 subagent 并发执行，提供有界调度、输入顺序稳定的结果和明确的失败/取消语义。

插件为 dynamic activation，依赖 `subagent` 插件提供的 `subagentRunner` 服务。加载器会在需要时递归加载该依赖。

## Tool

| 名称 | 类别 | 用途 |
|---|---|---|
| `subagent_batch` | `control` | 并发执行一组 `{ task, context? }` 子任务 |

```json
{
  "tasks": [
    { "task": "检查 API 层的错误处理" },
    { "task": "检查 UI 层的可访问性" }
  ],
  "maxConcurrency": 2,
  "failFast": false
}
```

返回报告始终保持输入顺序，不受实际完成顺序影响。`failFast` 只阻止尚未开始的任务；已经运行的任务会收尾。父调用 abort 会传播给所有子任务。

## Configuration

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `maxTasks` | `8` | 单次最大子任务数 |
| `maxConcurrency` | `4` | 最大并发数 |

并发 prompt 通过 `subagent` 的 AsyncLocalStorage 隔离。开发验证：`node --test .flavorlite/plugins/subagent-pool/index.test.mjs`。
