# flavor-ui

A flight-recorder UI plugin for the flavor-lite terminal. A single lifecycle
rail connects the user query, streamed model text, tool nodes and the final
turn result. The safe default is richly styled but static; animation is an
explicit opt-in.

```
╭─ ❯ fix the failing test in cli.test.ts
│  I will inspect the failure first.
├─ ✓ Read  tests/cli.test.ts  ‹FILE›  (0.42s)
├─ ✗ Write  src/cli.ts  ‹FILE›  (0.31s)
│  error: EACCES: permission denied
╰─ ⚡ 2 turns · 1.2k → 860 tokens · 8.4s
```

The green ✓ / red ✗ / family-accented spinner become the visual grammar of a turn:
you always know what the agent is doing, how long it took, and whether it
worked — without reading tool output dumps.

## Install

本项目已安装:`flavor-ui/` 位于项目插件根 `.flavorlite/plugins/flavor-ui/`
(flavor-lite 的磁盘插件发现根之一)。启动 REPL 即自动加载;已在运行时执行:

```text
› /plugin reload
```

检查加载状态:

```text
› /plugin list
```

装到其他项目:把整个 `flavor-ui/` 目录复制到该项目的
`.flavorlite/plugins/`,或放到用户级 `~/.flavorlite/plugins/`(对所有项目
生效,项目同名插件优先)。

## Usage

| Command | Effect |
|---|---|
| `/ui` | show the current style |
| `/ui on` | full style: animated active tool + previews |
| `/ui off` | plain style: static indicator with one in-place settlement (default) |

Tab-completion works for `/ui on|off` while typing in the REPL.

### Startup banner

The welcome screen is delegated to the plugin too. When flavor-ui is
loaded, the REPL banner becomes a status card instead of three plain
lines: version, model, permission mode (semantically colored), session id,
plugin health, and failed-plugin alerts:

```text
╭─ FLAVOR//LITE  flavor-lite · everything is a plugin   v0.3.0
├───────────────────────────────────────────────────────────────
model    openai:deepseek-v4-flash    mode    default
session  20260816-194835-6bac11      plugins 8/9 loaded
✗ 1 plugin failed: websearch (/plugin list)
╰─ type /help for commands · input while running becomes steering
```

Mode colors: `default` green, `plan` yellow, `acceptEdits` cyan,
`bypass` red. Plugin health is green when everything loaded, yellow
otherwise. On narrow terminals the panel collapses to one column.

The plugin provides the `ui` service. Unmounting it (`/plugin eject
flavor-ui`, or reload into an error) restores the host's default rendering
immediately — there is no state to clean up.

### Cross-plugin presentation

All plugins share the lifecycle rail, while compact badges make their roles
immediately recognizable: `FILE`, `VERIFY`, `GIT`, `LSP`, `PROCESS`, `AGENT`,
`PLAN`, `MEMORY`, `WEB`, and `CODE`. Verification, process, language-server
and subagent tools keep one useful success line visible even in static mode;
read-heavy tools stay compact.

Plugins with custom tools can extend the UI without touching the host:

```js
const dispose = ctx.tryGet("ui")?.registerToolPresentation("acme_scan", {
  badge: "ACME",
  accent: "amber",
  previewOnSuccess: true,
});
```

The returned disposer removes only that registration. Later registrations
win, unknown tools fall back to their tool category, and presentation metadata
never affects permissions or execution. Plugins that print richer blocks
directly (such as `filediff` and `task-planner`) call `pauseAnimation()` first,
so their output cannot overwrite an active tool row.

## Configuration

`flavor-plugin.json` → `config`:

```json
{ "config": { "style": "plain" } }
```

`"style": "plain"` (default) keeps the visual rail without timers: a tool starts
as `○` on an open row, then that same row settles once to `✓/✗` with duration.
`"style": "full"` additionally animates the active tool and shows one-line result
previews.

## Behavior notes

- **Color & animation degrade automatically.** When stdout is not a TTY
  (pipes, `-p` one-shot into a file) or `NO_COLOR` is set, no ANSI codes
  and no spinner are emitted.
- **Text is never buffered.** `text_delta` events are written straight to
  the terminal, so streaming feels as live as the default renderer.
- **Spinner rewrites one line in place** while a tool runs. A `steering`
  message typed mid-tool can briefly interleave with that line; the final
  ✓/✗ card always ends up correct.
- **One tool, one final row on TTY.** Plain mode performs one synchronous
  settlement rewrite. If a permission prompt or a plugin-owned rich block
  needs the terminal, `pauseAnimation()` seals the active row first and the
  final status safely continues on a new row. Redirected/non-TTY output stays
  append-only and never emits cursor-control sequences.
- **Hot reload mid-turn is not supported** by the plugin loader (any
  plugin); reload while idle.

## How it works

The host owns the terminal but delegates rendering to an optional `ui`
service (see `src/host/render.ts`). This plugin is just another disk
plugin: it `provides: ["ui"]` and the host picks it up at the start of
each turn — event streams, echoed input, errors, and the startup banner
(`renderBanner`) are all methods on the same service, so one plugin
controls the whole look. The renderer lives in `renderer.js` (pure,
injectable, unit tested); `index.js` mounts it, registers `/ui`, and adds
completion.
