# flavor-lite Plugin Development Spec

Everything in flavor-lite is a plugin — and third-party extensions use the
exact same contract as the built-ins. This document is the single source of
truth for writing a plugin that the kernel can discover, load, and hot-reload.

## Quick start

```text
# inside the flavor-lite REPL
/plugin new my-plugin        # scaffold .flavorlite/plugins/my-plugin/
# edit .flavorlite/plugins/my-plugin/index.js
/plugin reload my-plugin     # hot reload, no restart
/plugin list                 # status + errors
```

Or by hand: create `.flavorlite/plugins/<name>/` with two files —
`flavor-plugin.json` and `index.js` — then restart or `/plugin reload`.

## Directory layout

```text
.flavorlite/plugins/<name>/
├── flavor-plugin.json   # manifest (required)
├── index.js             # ESM entry (default; override with "entry")
└── ...                  # anything else: vendor/, helpers, README
```

Discovery roots (earliest shadows later, by manifest name):

1. `<project>/.flavorlite/plugins/`
2. `~/.flavorlite/plugins/` (user-global)

Directories without a `flavor-plugin.json` are ignored.

## Manifest: flavor-plugin.json

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "entry": "index.js",
  "description": "One sentence shown in /plugin list contexts.",
  "config": { "greeting": "hi" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique plugin identity (discovery key, reload key) |
| `version` | no | Free-form, defaults to `0.0.0` |
| `entry` | no | Entry file relative to the plugin dir; default `index.js` |
| `description` | no | Human-readable summary |
| `config` | no | JSON object passed as the `config` argument of every plugin's `apply(ctx, config)` |

Invalid JSON or a missing `name` marks the plugin `error` in `/plugin list`;
the rest of the host keeps running.

## Entry module contract

Plain ESM JavaScript (`.js` / `.mjs`). No build step, no dependencies on
`flavor-lite` itself — a plugin is a plain object literal. Third-party npm
dependencies are not resolved for you; vendor them inside the plugin dir.
TypeScript authors compile to ESM and point `entry` at the output.

The module's **default export** is one `Plugin` or an array of `Plugin`s:

```js
export default {
  name: "my-plugin",            // must be unique across the whole runtime
  inject: ["hooks", "tools"],   // SERVICE KEYS that must exist (ordering + fail-loud)
  provides: ["myService"],      // SERVICE KEYS this plugin claims via ctx.provide()
  apply(ctx, config) {
    return ctx.effect(() => {
      // register tools / commands / hooks / services here
      return () => { /* undo EVERYTHING, in reverse order */ };
    }, "my-plugin.install");
  },
};
```

### The Plugin contract

- `name` (string, required) — unique among all active plugins.
- `inject` (string[], optional) — service keys that must already be provided.
  The kernel fails loud when one is missing. **These are service keys, not
  plugin names** — the loop plugin provides `"agent"`, not `"loop"`.
- `provides` (string[], optional) — service keys this plugin claims. Two
  plugins providing the same key fail loud at mount time. The list is a
  **contract**: calling `ctx.provide()` with a key outside it fails loud
  (`service/undeclared`). Omit the field for implicit (unchecked) providing.
- `config` (Standard Schema v1, optional) — e.g. a zod schema. The kernel
  validates the manifest `config` against it before `apply` and passes the
  validated (possibly transformed) value. Failures report the issue path.
- `apply(ctx, config)` (required) — runs once on mount. May be `async`;
  effects registered after an `await` stay scoped to the plugin. Returns a
  disposer that must fully undo everything `apply` registered (tools,
  commands, hooks, services, timers). Wrap registrations in `ctx.effect()`
  to get reverse-order teardown.

### The PluginContext API

| Member | Purpose |
|---|---|
| `ctx.cwd` | The agent's working directory |
| `ctx.logger` | `debug/info/warn/error` — the host logger |
| `ctx.provide(key, service, options?)` | Claim a service key; returns a disposer that restores the previous provider. Keys owned by another plugin are protected — pass `{ override: true }` to shadow deliberately |
| `ctx.get(key)` | Resolve a service; throws when absent (fail loud) |
| `ctx.tryGet(key)` | Resolve an optional service; `undefined` when absent |
| `ctx.whenAvailable(key, signal?)` | Resolve now, or wait until the service appears (disk plugins mount after start, so services can show up late). Rejects on dispose/abort. For repeat reads of a service that may be ejected again, prefer `ctx.tryGet` |
| `ctx.effect(setup, label)` | Track a reversible registration; teardown in reverse order |
| `ctx.active` | False once the runtime starts disposing |

## Services you can inject

Available after the default stack starts (all of these exist when your
plugin loads):

| Key | Service | Typical use |
|---|---|---|
| `hooks` | `hook(name, listener)` / `waterfall(name, value)` | Attach to any waterfall below |
| `tools` | `register(tool)` → disposer | Add a model-callable tool |
| `commands` | `register(command)` → disposer | Add a `/slash` command |
| `systemPrompt` | `assemble()` | Read the assembled prompt |
| `llm` | `providers()`, `defaultRef()`, `registerAdapter()` | New model providers |
| `permission` | `mode()`, `setMode()`, `evaluateStatic()` | Policy awareness |
| `session` | `create/open/list/latest` | Session access |
| `agent` | `run()`, `steer()` | Drive the loop programmatically |
| `skills` | `discover()` | Skill discovery |
| `interaction` | terminal ask/confirm (when mounted) | Interactive prompts |
| `pluginsLoader` | `init/reload/list/scaffold` | Meta: manage plugins |
| `repl` | `registerCompleter(provider)` → disposer | Add `/`-completion candidates in the REPL |

`repl` exists only while the interactive REPL is running (not in one-shot
`-p` mode) — resolve it with `ctx.tryGet("repl")` and no-op when absent.
Candidates are `{ display, description?, completion? }`; the host renders
them below the input line with the typed prefix highlighted and completes
on Tab. See `.flavorlite/plugins/command-hints/` for a full example.

### Registering a tool

```js
ctx.get("tools").register({
  name: "my_tool",                       // unique, snake_case
  description: "When and why the model should call this.",
  category: "read",                      // read | write | shell | control
  inputSchema: { type: "object", properties: { /* JSON Schema */ } },
  async execute(args, execCtx) {         // execCtx: { cwd, signal?, onUpdate? }
    return { content: "result text" };   // { content, isError? } — never throw
  },
});
```

`category` drives the permission engine: `read` is always allowed, `write` /
`shell` follow the current permission mode.

### Contributing to the system prompt

The prompt is a pure assembler — every section comes from a plugin through
the `prompt/assemble` waterfall:

```js
ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
  event.sections.push({ name: "my-plugin", content: "Instructions for the model." });
  return next(event);   // ALWAYS delegate unless you intentionally short-circuit
});
```

Same-name sections: last one wins. Section order follows mount order.

## Waterfall hooks

Around-middleware: your listener receives the payload and `next`; call
`next(payload)` to continue the chain, or return without calling it to
short-circuit.

| Hook | Payload | Purpose |
|---|---|---|
| `prompt/assemble` | `{ cwd, sections[] }` | Contribute system-prompt sections |
| `tools/before-call` | `{ toolCall, tool, args, block?, reason? }` | Veto (`block = true`) or rewrite args |
| `tools/after-call` | `{ toolCall, args, result }` | Rewrite/annotate tool results |
| `loop/before-request` | `{ messages, systemPrompt, tools }` | Inspect/rewrite the outgoing request |
| `loop/compact` | `{ messages }` | Trim history when context overflows |

## Hot reload semantics

- `/plugin reload <name>`: unmount (disposers run in reverse mount order) →
  re-import the entry with a cache-busting query → remount. Your changes are
  live immediately.
- `/plugin reload` (no name): full re-discovery; also picks up newly created
  plugin dirs and forgets removed ones.
- Reload failures never crash the host: the previous version is already
  unmounted, the new failure shows up in `/plugin list` as `error`.
- Don't reload while a turn is mid-flight (a tool call of the old version may
  still be running); prefer idle moments.
- SDK hosts replacing a service provider that still has consumers should use
  `runtime.reload(name, plugin, config)`: the replacement activates first and
  takes over the old instance's registrations atomically — consumers never
  see a gap, and a failed replacement leaves the old instance untouched.

## Common errors

| Symptom | Cause / fix |
|---|---|
| `requires service "X", but no mounted plugin provides it` | `inject` names a service key that doesn't exist — check the table above (it's `agent`, not `loop`) |
| `service "X" is provided by both ...` | Two plugins claim the same `provides` key |
| `service "X" is owned by plugin "Y"` | Your plugin provides a key another plugin already owns — use a different key, or `{ override: true }` if shadowing is intentional |
| `plugin "X" provides service "Y", which is not in its declared provides` | `ctx.provide()` used a key outside the plugin's `provides` list — declare the key, or omit `provides` for implicit mode |
| `cannot unmount "X": service "Y" is still injected by ...` | The kernel refuses to leave dangling consumers — unmount the dependents first (or reload the whole group) |
| `plugin "X" has an invalid config` | Manifest `config` failed the plugin's Standard Schema — the message lists each issue with its path |
| `plugin name "X" is already active` | Two entry modules export the same plugin `name` |
| `entry module must have a default export` | Add `export default { name, apply }` |
| `/plugin list` shows `error: import failed` | Syntax error or missing dependency in the entry — the message has details |
| Reload shows stale behavior | You edited a file the entry imports indirectly; `/plugin reload` re-imports the whole module graph with a fresh cache key, so check `entry` points at your real entry |

## Minimal example

```text
.flavorlite/plugins/uptime/
├── flavor-plugin.json   { "name": "uptime", "version": "0.1.0" }
└── index.js
```

```js
import { uptime } from "node:process";

export default {
  name: "uptime",
  inject: ["commands"],
  apply(ctx) {
    return ctx.effect(
      () => ctx.get("commands").register({
        name: "uptime",
        description: "Show process uptime",
        run: () => `up ${Math.round(uptime())}s`,
      }),
      "uptime.install",
    );
  },
};
```
