# subagent

A flavor-lite plugin that lets an agent spawn child agents for delegated work.
Children can spawn children too, up to **3 nesting levels** (root → child →
grandchild → great-grandchild); a deeper spawn is rejected by the runtime.

## Install

```text
/plugin reload subagent     # or restart the host
/plugin list                # should show subagent ... loaded
```

This directory lives at `.flavorlite/plugins/subagent/`, the project plugin
root, so it is discovered automatically.

## What it adds

### Tool: `subagent_spawn`

The model calls this to hand a task to a fresh child agent:

| Argument        | Required | Meaning |
|---|---|---|
| `task`          | yes      | Self-contained task description; the child cannot ask questions |
| `role`          | no       | Optional persona, e.g. "a code reviewer" |
| `maxIterations` | no       | Iteration cap for the child loop (default 30, capped at 30) |

The child runs its own agent loop with:

- an **isolated session** (its history never pollutes the parent's; the parent
  only sees the final report),
- a **child-specific system-prompt section** naming its role, task, and depth,
- the **same tools and permission policy** as the parent (children are not a
  policy bypass),
- propagation of the parent's abort signal.

### Prompt section: `subagents`

Guidance on when to delegate, mounted with the plugin so the model knows the
tool exists and its limits.

## Report guarantee

The loop exits at the iteration cap without a final turn, so a child that
spent every iteration on tool calls would otherwise hand back nothing. The
tool defends in three layers:

1. The child's prompt section names its iteration budget and tells it to
   reserve the last iteration(s) for the report.
2. When the first run ends with no text, the tool drives a short wrap-up run
   (2 iterations) in the same session: "budget exhausted, stop calling tools,
   write the report now".
3. If even the wrap-up stays silent, a digest of the child's tool calls is
   reconstructed from its session log, and the report head always carries the
   child session id so the parent can inspect the full trail.

## Depth limit

- Root agent: depth 0 (implicit).
- `subagent_spawn` from depth `N` runs its child at depth `N + 1`.
- Spawning at depth 4 (i.e. a child of a depth-3 agent) returns an error to
  the caller: `Cannot spawn a subagent at depth 4: the maximum nesting depth
  is 3.`

Depth is tracked with `AsyncLocalStorage`, so a child's own spawn calls see
their depth automatically without any change to the loop plugin.

## Configuration

`flavor-plugin.json` → `config`:

| Key                    | Default | Meaning |
|---|---|---|
| `maxDepth`             | `3`     | Maximum nesting depth for children |
| `defaultMaxIterations` | `30`    | Child loop iteration cap when the call omits `maxIterations` |

## Notes

- Hot-reload safe: `/plugin reload subagent` unwinds the tool, the prompt
  section, and the async depth tracking, then re-imports.
- A rejected spawn creates no session file — no orphaned history on disk.
