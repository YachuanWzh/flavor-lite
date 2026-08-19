# Spec: task-planner 持久化（plan_end 归档 + /plan-log）

> SDD 规格。对应 docs/self-evolve.md 3.1 的 plan 侧：task-planner 当前是纯内存态，
> 计划执行历史随进程消失，无法沉淀可复用模板/反模式。本期只做持久化数据面。

## 1. 目标

- 新增 `plan_end` 工具：把当前计划（goal + 各任务终态）序列化归档到磁盘，随后清空内存态。
- 新增 `/plan-log` 命令：列出最近归档计划，供人/模型复盘。
- 为后续"成功计划→模板、失败计划→反模式"的自进化留数据面（提炼本身不在本期）。

## 2. 数据布局

`.flavorlite/task-planner/plans.jsonl`，一行一条：

```json
{
  "goal": "...",
  "tasks": [{ "content": "...", "detail": "...", "status": "done" }],
  "outcome": "success" | "partial" | "failed",
  "startedAt": "ISO", "endedAt": "ISO"
}
```

## 3. 行为

| 面 | 变更 |
|---|---|
| `plan_start` | 计划对象新增 `startedAt`（创建时刻 ISO） |
| `plan_end`（新工具，category: control） | 参数 `outcome`（enum，必填）；无活动计划 → isError；归档后清空内存（plan_view 返回 No active plan），终端渲染归档提示 |
| `/plan-log [n]`（新命令） | 打印最近 n 条（默认 10）：goal、outcome、任务 done/总数、endedAt |
| GUIDANCE | 补一条：多步任务收尾时调用 plan_end 归档 |
| inject | 追加 `"commands"` |

## 4. 验收清单（对应测试）

1. plan_start → plan_update → plan_end(outcome=success)：plans.jsonl 出现一条含
   goal/tasks/outcome/startedAt/endedAt 的记录；任务状态是最后更新值。
2. 无活动计划时 plan_end → isError。
3. plan_end 后内存清空：plan_view 返回 "No active plan."，plan_update 报错。
4. 连续两次 plan_start/plan_end → plans.jsonl 有两条记录（追加语义）。
5. `/plan-log` 输出包含归档的 goal 与 outcome；无归档时提示为空。

## 5. 不做的事

- 不做模板提炼/反模式总结（需要足够积累后由反思层消费 plans.jsonl）。
- 不改 board 渲染逻辑与既有三个工具的交互契约。
