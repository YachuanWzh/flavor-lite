# 自进化批次二：导出、晋升、triggers 回写、信号联动

> 对应 docs/evolve.md 路线图 3.6（晋升阶梯）、3.7（triggers 自动维护）、
> 3.5（信号质量）的插件级落地。全部在 `.flavorlite/plugins` 内完成，内核零改动。
> 执行方式：SDD（本文档）+ TDD（测试先行）。

## 范围（四项，均人类命令门控）

1. **SFT 导出** — evolve 插件新增 `/evolve export [limit]`
2. **技能晋升阶梯** — skill-distiller 新增 `/distill promote <slug>`
3. **triggers 回写** — evolve 插件新增 `/evolve learn`
4. **信号联动** — evolve 的 `/evolve suggest` 与 `evolve_improve` 消费
   error-monitor 的高置信度 LLM 分析记录

## 1. SFT 导出（/evolve export）

**动机**：成功会话是微调/蒸馏原料；session 文件混有 steering 噪声，需要一个
干净、定长、可直接投喂训练管道的导出面。

**行为**：
- 数据源：`ctx.tryGet("session")`（可选服务）。无 session 服务时返回
  `no session service available`，不报错。
- 取 `session.list()` 前 `limit` 条（默认 `config.exportLimit ?? 20`）。
- 每个会话过滤：只保留 `role ∈ {user, assistant}`；丢弃 `[steering]` /
  `[system]` 前缀的 meta user 消息；content 非字符串的消息跳过；单条 content
  截断 20000 字符。
- 过滤后消息数 < 4 的会话视为轨迹不完整，跳过。
- 覆盖写 `<cwd>/.flavorlite/evolve/sft.jsonl`，每行
  `{"sessionId", "exportedAt", "messages": [{"role","content"}]}`。
- 返回 `exported N session(s) -> <path>`（N=0 时说明无合格会话）。

**边界**：只读 session 存储；不改 reflections/signals；`/evolve clear` 不删导出物。

## 2. 技能晋升阶梯（/distill promote）

**动机**：generated 技能是模型自产的低权威知识；被人类验证有效的应晋升为
curated（脱离生成配额、免于 `/distill rm` 误删）。这是 memory→skill→plugin
阶梯中 skill 层的人工闸门。

**行为**：
- `/distill promote <slug>`：
  - slug 不存在 → `no skill named "<slug>"`；
  - 非 generated（人写或已晋升）→ `refusing: "<slug>" is not a generated skill`；
  - 否则重写 front-matter：`generated: true` → `generated: false`，并追加
    `promoted: true` 与 `promotedAt: <ISO>`；返回 `promoted "<slug>" to curated`。
- `/distill rm <slug>`：语义不变（仅允许删 `generated: true` 的），
  晋升后因 `generated: false` 自动受保护。
- `/distill` 列表：晋升条目显示 `(promoted)`；generated 计数只统计
  `generated: true`，晋升自动释放生成配额。

## 3. triggers 回写（/evolve learn）

**动机**：router-memory.json 已积累 `{fp, plugin, used}` 召回反馈，
自产/粗写插件的 manifest keywords 往往不准；让插件从真实召回结果学会
"什么请求该叫我"（L0 确定性召回，摆脱对 L1 打分的依赖）。

**行为**：
- 容错读 `<cwd>/.flavorlite/router-memory.json`（缺失/损坏 → `no router feedback memory found`）。
- 按插件计 token 得分：该插件 `used:true` 条目含该 token +1，
  `used:false` 条目含该 token -1。候选 = 得分 ≥ 1 且长度 ≥ 2 的 token。
- 对 `loader.list()` 中名字命中的插件：读其目录下的 flavor-plugin.json，
  将候选合并进 `triggers.keywords`（大小写不敏感去重），总数上限 16；
  有新增才写回（2 空格缩进保持可读）。写失败跳过该插件（fail-safe）。
- 输出每插件 `learned triggers: <name> +[t1, t2]`；无任何新增时
  `no new triggers learned`。
- 幂等：重复执行不再新增（去重保证）；loader watch 会自动同步 catalog。

**边界**：只写 manifest 的 triggers.keywords 字段，其余字段原样保留。

## 4. 信号联动（evolve × error-monitor）

**动机**：evolve 自采的失败信号只有 (tool, error) 两维；error-monitor 有
更丰富的 kind/analysis/confidence。两个插件共享同一失败世界却互不相识，
建议质量受限。

**行为**（文件级集成，error-monitor 插件零改动）：
- evolve 容错读 `<cwd>/.flavorlite/error-monitor/records.json`
  （格式 `{version, records: [...]}`）。
- 入选条件：记录有 `analysis` 字符串且 `(confidence ?? 1) >= config.emConfidence`
  （默认 0.7）；id 前缀 `em:` 避免与信号指纹碰撞。
- `/evolve suggest`：在失败建议与 trigram 提议之后追加
  `[em:<id>] (analyzed error) <tool> x<count>: <analysis>`；
  `done.json` 中已标记 `em:<id>` 的不再出现。
- `evolve_improve`：建议查找池并入上述条目，`tool` 字段使两种 kind
  （plugin 脚手架 / prompt_rule）均可用；`markSuggestionDone("em:<id>")`
  复用既有 done.json。
- `prompt/assemble` 不变（error-monitor 已注入 tool-error-lessons，避免重复）。
- EvolveStore 新增 `readDoneIds()`（enqueue 内读 done.json）。

## 测试计划（TDD，先红后绿）

- `tests/evolve-plugin.test.ts` 新增：
  - export 写 sft.jsonl、过滤 steering meta、跳过短会话、无 session 服务优雅降级；
  - learn 将 used:true 的 fp token 合并进 manifest keywords、二次执行幂等；
  - suggest 展示 `em:` 条目、`/evolve done em:<id>` 后消失、
    evolve_improve 可消费 em 建议。
- `tests/skill-distiller.test.ts` 新增：
  - promote 改写 front-matter（generated:false + promoted:true + promotedAt）；
  - 晋升后 rm 拒绝、列表显示 (promoted)、配额释放；非 generated 拒绝晋升。
- 收尾：`npm test` 全量、`npm run build`、`loader.verify` 冒烟两个插件。

## 验收标准

1. 四项全部命令可用且幂等/可逆；
2. 内核（src/）零改动；
3. 全量测试绿、构建通过。
