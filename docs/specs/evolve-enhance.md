# Spec: evolve 插件增强（prompt_rule 分支 + 成功轨迹工具提议）

> SDD 规格。对应 docs/self-evolve.md 的 3.2 方向与 3.1 的 prompt 侧；
> 实现范围仅 `.flavorlite/plugins/evolve/`（store.js + index.js），内核零改动。

## 1. 目标

1. **补齐 prompt_rule 分支**：`evolve_improve` 工具描述声明 `kind=plugin|prompt_rule`，
   但源码只有 plugin 分支（文档/实现不一致）。prompt_rule 应把修复沉淀为一条行为规则
   写入 `.flavorlite/evolve/rules.md`，并由 `prompt/assemble` 注入系统提示。
2. **从成功轨迹提议新工具**：当前只对失败反应。记录每次成功工具调用的序列，
   会话结束时聚合连续 3 元组（trigram），跨 run 重复出现达到阈值时产出
   `kind=tool` 建议（"封装为新工具/命令"），与失败建议同面展示。

## 2. 数据布局（.flavorlite/evolve/）

| 文件 | 变化 | 说明 |
|---|---|---|
| `rules.md` | 新增 | 一行一条规则；`appendRule` 去重追加；空文件/缺失=无规则 |
| `patterns.jsonl` | 新增 | `{ id, sequence: string[], firstAt, lastAt, count }`；id = sha1(sequence.join("->"))前 12 位；按 count 去重累加，上限同 signals（400） |
| `done.json` | 复用 | pattern 建议 id 与 signal id 共用同一 done 账本 |

## 3. 钩子与行为

### store.js 新增

- `readRules(): Promise<string>` — 缺失返回 `""`
- `appendRule(text: string): Promise<void>` — 归一化单行；完全重复不追加
- `recordPattern({ sequence: string[] }): Promise<{added, record}>` — 指纹去重计 count
- `patterns(): Promise<Pattern[]>` — 按 count 降序
- `openPatternSuggestions({ threshold, limit })` — count >= threshold 且未 done，
  返回 `{ id, kind: "tool", sequence, count, hint }`

### index.js 变更

- **tools/after-call**：`isError !== true` 时把工具名推入本次 run 的内存缓冲
  （只记名字不记参数值）；失败分支行为不变。
- **loop/after-run**：对缓冲提取滑动窗口 trigram，**同一 run 内同一 trigram 只记一次**
  （跨 run 累计才有意义），逐条 `recordPattern`，随后清空缓冲；reflection 逻辑不变。
- **prompt/assemble**：现有 suggestions section 不变；rules.md 非空时追加
  `{ name: "evolve-rules", content }` section。
- **evolve_improve 工具**：`inputSchema` 增加 `kind: enum["plugin","prompt_rule"]`
  （缺省 plugin）。prompt_rule 分支：`appendRule(implementation)` +
  `markSuggestionDone(suggestionId)`，不脚手架；plugin 分支行为不变。
  建议查找范围 = 失败建议 ∪ pattern 建议。
- **/evolve suggest**：失败建议与 pattern 建议合并输出，后者标注 `(tool proposal)`。

### 配置（manifest config，均有默认值）

| 键 | 默认 | 含义 |
|---|---|---|
| `promptTop` | 3 | 失败建议注入条数（现有） |
| `minRepeats` | 2 | 失败建议阈值（现有） |
| `patternThreshold` | 3 | trigram 出现次数达到才提议 |
| `patternTop` | 2 | pattern 建议注入条数 |

## 4. 验收清单（对应测试）

1. `evolve_improve` 以 `kind=prompt_rule` 执行 → rules.md 出现该规则行，建议被标记 done；
   不产生插件目录。
2. rules.md 非空时 `prompt/assemble` 载荷含 `evolve-rules` section 且内容包含规则；
   空时不含。
3. `evolve_improve` 缺省 kind（plugin 分支）行为不回归：仍脚手架 + 写 PLAN.md。
4. 成功工具调用不产生 signal（现有断言保持）。
5. 连续成功调用序列跨 3 个 run 重复同一 trigram → patterns.jsonl count=3，
   `/evolve suggest` 出现 tool proposal；未达阈值时不出现。
6. 同一 run 内重复 trigram 只计 1 次。

## 5. 不做的事

- 不改内核、不改 loop 载荷；不改 verify/revert/snapshot 链路。
- pattern 建议的"自动封装成工具"不做——只提议，由模型/人决定（保持有界 RSI）。
