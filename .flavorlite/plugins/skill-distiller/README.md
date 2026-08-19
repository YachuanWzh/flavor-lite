# skill-distiller

Distills successful multi-step sessions into reusable SOP skills
(`.flavorlite/skills/<slug>/SKILL.md`, front-matter marked `generated: true`),
which the skills plugin then discovers and injects into later sessions.

## Loop

```
loop/after-run (reason=finished, toolCalls >= minToolCalls, cap not reached)
  -> session transcript -> LLM strict-JSON proposal (or {"skip": true})
  -> write SKILL.md -> auto-discovered next session
```

## Gates (anti-spam)

- only `finished` runs with `toolCalls >= minToolCalls` (default 8)
- total generated skills capped at `maxGenerated` (default 20)
- existing slugs are never overwritten; existing skill names are fed to the
  LLM so it can skip duplicates
- fire-and-forget: never blocks the loop; failures only warn in the log

## Config (flavor-plugin.json)

| key | default | meaning |
|---|---|---|
| `minToolCalls` | 8 | minimum tool calls in a run before distillation |
| `maxGenerated` | 20 | maximum number of generated skills on disk |

## Commands

- `/distill` — list skills and how many are generated
- `/distill rm <slug>` — remove a generated skill (human skills are protected)

## Service

Provides `skillDistiller` with `idle()` (awaits pending distillations;
used by tests and diagnostics).
