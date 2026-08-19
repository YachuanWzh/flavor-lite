# Spec: skill-distiller 插件（成功会话自沉淀 SOP）

> SDD 规格。对应 docs/self-evolve.md 3.3（ROI 最高的新能力）：skills 插件已有
> 发现 + 注入，缺"生成"端。本插件补齐：会话成功结束时用 LLM 提炼 SOP，
> 写入 `.flavorlite/skills/<slug>/SKILL.md`，下次会话自动被发现注入。

## 1. 形态

`.flavorlite/plugins/skill-distiller/`（manifest + 纯 ESM index.js），
复用 memory 插件 `extractMemories` 的 LLM 抽取模式（collectLlmText + fire-and-forget）。

## 2. 钩子与门槛

挂 `loop/after-run`，全部满足才提炼（防滥用）：

| 门槛 | 默认 | 说明 |
|---|---|---|
| `reason === "finished"` | — | 只学成功收尾的会话 |
| `toolCalls >= minToolCalls` | 8 | 步骤太少不值得沉淀 |
| `generatedCount < maxGenerated` | 20 | 生成 skill 总量上限（扫 skills 目录 `generated: true` 计数） |
| slug 目录不存在 | — | 与既有 skill 同名直接跳过 |

- `llm` / `session` 经 `ctx.tryGet` 惰性获取，缺任一静默跳过。
- transcript 经 `session.latest()` → `session.open(id).messages()`。
- fire-and-forget，失败只 logger.warn；pending Promise 记入服务 `idle()` 供测试/诊断等待。

## 3. LLM 契约

系统提示要求输出**严格 JSON**（可带 ```json 围栏）：

- `{"skip": true, "reason": "..."}` — 无新知识/与既有 skill 重复（既有 skill 名单喂给模型）；
- `{"name": "...", "description": "一句话触发条件+用途", "body": "markdown SOP"}`。

解析失败 / skip / name 非法 → 不落盘。

## 4. 落盘格式

```
---
name: <name>
description: <description>
generated: true
distilledAt: <ISO>
---
<body>
```

目录名 slug = name 小写、非字母数字转 `-`。skills 插件只读 name/description，
额外字段无害；目录名即 skill 身份。

## 5. 服务与命令

- provides: `["skillDistiller"]` — `{ idle(): Promise<void> }`（等待所有 pending 提炼）。
- `/distill`：列出全部生成 skill；`/distill rm <slug>` 删除（仅允许删
  `generated: true` 的目录，人写 skill 拒绝删除）。

## 6. 验收清单（对应测试）

1. 门槛达标（finished + toolCalls≥8 + LLM 返回有效 JSON）→ SKILL.md 生成，
   front-matter 含 generated: true，正文含 body；LLM 收到 transcript。
2. reason != finished 或 toolCalls 不足 → 不调 LLM、无文件。
3. LLM 返回 `{"skip": true}` → 无文件。
4. slug 已存在 → 不重复写。
5. generated 数量达 maxGenerated → 不调 LLM。
6. `/distill` 列出生成 skill；`/distill rm` 可删生成的、拒绝删人写的。

## 7. 不做的事

- 不做 skill 质量评分/自动淘汰（后续由 router 反馈驱动）。
- 不改 skills 插件与内核；不读其他插件的数据文件。
