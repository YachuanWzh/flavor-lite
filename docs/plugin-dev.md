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
  "manifestVersion": 1,
  "apiVersion": "1",
  "name": "my-plugin",
  "version": "0.1.0",
  "entry": "index.js",
  "activation": "dynamic",
  "profiles": ["coding", "full"],
  "requires": { "services": ["hooks", "tools"] },
  "engines": { "node": ">=22" },
  "triggers": { "keywords": ["my capability"] },
  "description": "One sentence shown in /plugin list contexts.",
  "config": { "greeting": "hi" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `manifestVersion` | no | Manifest format; currently `1` (default) |
| `apiVersion` | no | Host ABI; currently `"1"` (default), incompatible values fail before import |
| `name` | yes | Unique plugin identity (discovery key, reload key) |
| `version` | no | Free-form, defaults to `0.0.0` |
| `entry` | no | Entry file relative to the plugin dir; default `index.js` |
| `description` | no | Human-readable summary |
| `config` | no | JSON object passed as the `config` argument of every plugin's `apply(ctx, config)` |
| `activation` | no | `eager`, `background`, `dynamic` (default), or `manual` |
| `profiles` | no | Activation visibility in `minimal`, `coding`, and/or `full` |
| `requires` | no | Required `services`, `executables`, and environment variable names |
| `engines.node` | no | Supported Node range such as `>=22` |
| `platforms` | no | Allowed `win32`, `linux`, or `darwin` hosts |
| `provides` | no | Exact host services exported by the entry; checked against its default export |
| `triggers` | no | Router keywords and regex patterns; syntax is checked before entry import |
| `resourceBudget` | no | Generated-process memory, call timeout, and output-size limits |
| `selfTest` | no | Optional verification command metadata |
| `lifecycle` | no | `active`, `candidate`, or `quarantined`; only active entries auto-load |
| `origin` | no | `"user"` (default, human-written) or `"generated"` (scaffolded by the agent). The permission engine holds generated plugins to tighter defaults |
| `generatedFrom` | no | Provenance of a generated plugin: session id or ISO timestamp |
| `capabilities` | no | Array of `"shell"` / `"network"` / `"files"` / `"host"` a generated plugin may exercise (see capability tiering below) |

Invalid JSON, ABI incompatibility, a bad trigger regex, or missing requirements
mark the plugin `error` in `/plugin list`; the rest of the host keeps running.
`/plugin doctor` reports these conditions without requiring an LLM provider,
and `/plugin explain <name>` shows why an entry is loaded or deferred.

### Activation and profiles

- `eager`: imported during startup for the selected profile.
- `background`: startup-loaded except in `minimal`; use for low-cost observers.
- `dynamic`: manifest-only until router recall or explicit reload.
- `manual`: manifest-only until explicitly reloaded.

Discovery never imports deferred entries. This makes a large plugin catalog
cheap: only manifests are parsed, while code and transitive dependencies stay
cold. `FLAVOR_PROFILE=minimal|coding|full` or `--profile` selects the profile.

### Capability tiering for generated plugins

The loader tracks which plugin registered each tool (`ownerOfTool`). The
permission engine then applies a manifest contract to tools owned by
`origin: "generated"` plugins, in every mode:

- **Undeclared capability → blocked.** Tool category `shell` requires the
  `"shell"` capability; category `write` requires `"files"`. A generated
  plugin without `capabilities` is read-only by default.
- **Declared capability → forced approval.** The first call per
  plugin+capability+path-scope asks the user, even in `acceptEdits`.
  Only `bypass` skips the prompt (never the undeclared-capability block).
- `"network"` and `"host"` are enforced by the generated-process capability
  broker just like `"files"` and `"shell"`.

Generated entry modules are imported only in a permission-restricted child
process. Their tools, commands, and prompt sections are JSON-RPC proxies; any
host action must cross the capability broker and then the ordinary permission
hooks. Generated plugins cannot provide arbitrary in-process services.

`read` category tools remain permission-light. The scaffolds written by
`/evolve improve` and `/ladder to-plugin` already stamp `origin` /
`generatedFrom`; add `capabilities` yourself when the plugin needs them.

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
| `tools` | `register(tool)` → disposer | Add a model-callable tool; exposes ownership and in-flight leases |
| `artifacts` | `put/read/list/prune` | Store complete large outputs outside the transcript |
| `evidence` | `begin/record/evaluate/latest` | Record required verification evidence and evaluate a run |
| `commands` | `register(command)` → disposer | Add a `/slash` command |
| `systemPrompt` | `assemble()` | Read the assembled prompt |
| `llm` | `providers()`, `defaultRef()`, `registerAdapter()` | New model providers |
| `permission` | `mode()`, `setMode()`, `evaluateStatic()` | Policy awareness |
| `session` | `create/open/list/latest` | Session access |
| `agent` | `run()`, `steer()` | Drive the loop programmatically |
| `skills` | `discover()` | Skill discovery |
| `interaction` | terminal ask/confirm (when mounted) | Interactive prompts |
| `pluginsLoader` | `init/reload/list/scaffold` | Meta: manage plugins |
| `telemetry` | `record/events/reduce` | Versioned, redacted signal feed plus deterministic projection |
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
    return {
      content: "result text",
      evidence: [{ kind: "test", ok: true, required: true, summary: "12 passed" }],
      diagnostics: [],
      artifacts: [],
    }; // never throw for an expected tool failure
  },
});
```

`category` drives the permission engine: `read` is always allowed, `write` /
`shell` follow the current permission mode. If `content` exceeds the configured
transcript budget, the full payload is stored through `artifacts` and the model
receives a bounded preview plus a stable reference.

### Contributing to the system prompt

The prompt is a pure assembler — every section comes from a plugin through
the `prompt/assemble` waterfall:

```js
ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
  event.sections.push({
    name: "my-plugin",
    content: "Instructions for the model.",
    priority: 60,
    maxChars: 4000,
    source: "my-plugin",
  });
  return next(event);   // ALWAYS delegate unless you intentionally short-circuit
});
```

Same-name sections: last one wins. Section order follows mount order. The
assembler enforces per-section and global character budgets, dropping the
lowest-priority material first; `/prompt inspect` explains the result.

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

- `/plugin reload <name>`: verify and activate the replacement first, wait for
  old in-flight tool calls, then atomically transfer registrations. Your
  changes are live without an availability gap.
- `/plugin reload` (no name): full re-discovery; also picks up newly created
  plugin dirs and forgets removed ones.
- Reload failures never crash the host and leave the previous active version
  untouched. Successful content-addressed snapshots support `/plugin revert`.
- In-flight tool leases are drained before takeover, so targeted reload is safe
  during a turn (subject to the configured timeout).
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
