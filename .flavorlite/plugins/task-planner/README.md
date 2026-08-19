# task-planner

A flavor-lite plugin for planning complex, multi-step work. The agent decides
when to use it: for a job with several meaningful, verifiable steps it calls
`plan_start` to decompose the work into atomic tasks, then keeps the board
current with `plan_update`. Every call re-renders a color-coded task board
straight to the terminal so the user always sees the live state.

## Status colors

| Status  | Color  |
|---------|--------|
| running | green  |
| pending | orange |
| error   | red    |
| done    | dim    |

Example board:

```text
Task Plan: Add dark mode
▶ 1、Add theme tokens — running
• 2、Write CSS variables — pending
✗ 3、Fix contrast on accent buttons — error
✓ 4、Run visual regression tests — done
```

## How it works

1. The agent calls `plan_start` with a goal (optional) and a list of atomic
   tasks. Each task must be one small, independently verifiable unit of work
   — the plugin guides the agent to decompose aggressively rather than emit
   compound steps. The first task starts `running`, the rest `pending`.
2. As work proceeds, the agent calls `plan_update` immediately after each
   task finishes (`done`) or fails (`error`). Only one task may be `running`
   at a time. When a `done` transition leaves no running task, the next
   pending task is promoted to `running` automatically.
3. `plan_view` re-renders the current board at any time.

The colored board is written directly to the terminal (ANSI codes, degraded
to plain text when stdout is not a TTY or `NO_COLOR` is set). The model only
receives a plain-text summary in tool results, so color codes never pollute
its context window.

## Tools

| Tool          | Category | Purpose                                    |
|---------------|----------|--------------------------------------------|
| `plan_start`  | control  | Create (or replace) the plan               |
| `plan_update` | control  | Change a task's status: pending/running/done/error |
| `plan_view`   | read     | Show the current board                     |

`control` tools are auto-approved in `default` and `plan` permission modes,
so the agent can plan without prompting the user for permission.

## Install

Place this directory at `.flavorlite/plugins/task-planner/`, then in the
flavor-lite REPL:

```text
/plugin reload
```

or just this plugin:

```text
/plugin reload task-planner
```

`/plugin list` shows load status and errors.

## Development

Edit `index.js` and run `/plugin reload task-planner` — no restart needed.
Reloading resets the in-memory plan state. See `docs/plugin-dev.md` in the
flavor-lite repo for the full plugin spec.
