# flavor-lite

> Everything is a plugin — even the agent loop.

flavor-lite is a lightweight coding agent built on the design philosophy of
deepseek-harness (Cordis): a tiny kernel plus capability seams, where every
behavior — LLM providers, tools, permissions, sessions, prompts, the loop
itself, and every feature — mounts as a reversible plugin. It keeps the best
ideas of flavor-code (permission modes, FLAVOR.md project guides, JSONL
sessions, sectioned system prompts) and pi (event-driven streaming loop,
steering messages, tool hooks), while staying small and fast.

## Why it's fast

- **Zero SDK dependencies** — provider adapters are raw `fetch` + SSE (the only runtime dependency is `zod`)
- **No second-pass review models** — one stream, straight to the terminal
- **Eager topological startup** — plugin order resolved once, zero runtime dispatch overhead
- **Real-time streaming** — text deltas render the instant they arrive
- **Retries only where they pay** — network/rate-limit backoff before anything is emitted

## Quick start

```bash
npm install
npm run build
cp .env.example .env   # set OPENAI_API_KEY or ANTHROPIC_API_KEY
node dist/cli.js
```

Or one-shot:

```bash
node dist/cli.js -p "add a README section about testing"
```

Works with any OpenAI-compatible gateway (DeepSeek, Moonshot, vLLM, Ollama):

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
FLAVOR_OPENAI_MODEL=deepseek-chat
```

## Architecture

```
src/
  kernel/      mini-Cordis: Context (services/effects only) + Runtime (topo-sort,
               typed errors, service ownership, atomic reload, event bus)
  shared/      provider-neutral Message model
  plugins/
    hooks/       the waterfall bus as a plugin: provides the `hooks` service
    llm/         capability seam: adapter registry, "provider:model" refs, pure fetch SSE;
                 provider plugins (provider:openai / provider:anthropic) self-register adapters from credentials
    tools/       capability seam: ToolRegistry + before/after-call waterfalls + 7 builtin tools
    permission/  plan|default|acceptEdits|bypass + hard dangerous-command blocks (a tools hook) + mode-aware prompt section
    session/     JSONL persistence under .flavorlite/sessions (model-visible ⇔ logged)
    prompt/      pure assembler: runs prompt/assemble over empty sections, dedupes, joins
    guidance/    identity/security/tasks/environment as unmountable prompt-section plugins
    loop/        the agent loop as a plugin: streaming, steering, retries, compaction hook
    compaction/  proactive + reactive history trimming (loop hooks, no loop changes)
    skills/      SKILL.md discovery → prompt section
    commands/    slash-command registry seam
    init/        FLAVOR.md project guide + /init generator
  host/        config merge, terminal interaction, rendering, REPL, bootstrap
  cli.ts       thin binary: flags → createAgent() → REPL or one-shot
```

### Kernel semantics (inherited from Cordis)

| Idea | In flavor-lite |
|---|---|
| Context is a service repository | `ctx.provide/get/tryGet` by stable key |
| Registrations are reversible effects | `ctx.effect()` → disposers unwind in reverse |
| Waterfall = around-middleware | the `hooks` plugin provides it: `hooks.hook(name, (value, next) => ...)`; skip `next()` to short-circuit |
| Everything is a plugin | even the hook bus is a plugin — unmount `hooks` and no hook point exists |
| Provider discovery is delegated | bootstrap mounts provider plugins; each self-registers if credentials exist, and the generic "no provider" check counts third-party plugins too |
| Plugins, not loop changes | permissions, compaction, guides all attach to seams/hooks |
| System prompt is runtime-derived | every section is a plugin contribution (`prompt/assemble`); unmount the plugin, lose the section |
| Model-visible ⇔ logged | session JSONL fully reconstructs any conversation |
| Fail loud | missing providers, duplicate services, cycles, bad config throw at startup |
| Services are owned | `ctx.provide()` claims a key for the activating plugin (owner travels via `AsyncLocalStorage`); cross-plugin overrides need `{ override: true }` |
| Declared provides is a contract | a plugin with `provides` cannot register a service outside that list — `service/undeclared` at activation |
| Reloads are atomic | `runtime.reload()` activates the replacement first, then it takes over the old registrations: consumers never see a gap |
| Late services are waitable | `ctx.whenAvailable(key)` resolves now or as soon as a dynamic plugin mounts it |

### Reliability

The kernel fails loud and stays observable: typed errors with stable codes
and structured details, service ownership with explicit `{ override: true }`,
declared `provides` contracts, atomic plugin reloads, bounded async
activation, resource caps, an event bus, and `runtime.inspect()` /
`runtime.plan()` for introspection.

### Self-evolution

A bounded, human-gated improvement loop lives entirely in disk plugins on the
standard seams: repeated tool failures become fix suggestions, recurring
success sequences are proposed as new tools, fixes can be distilled into
permanent prompt rules (`rules.md`), successful sessions are distilled into
reusable `SKILL.md` SOPs, and finished task plans are archived for reuse. See
`docs/self-evolve.md` and the specs in `docs/specs/`.

### Extension points

- Services: `hooks`, `llm`, `tools`, `permission`, `interaction`, `session`, `systemPrompt`, `agent`, `commands`, `skills`
- Waterfall hooks: `tools/before-call`, `tools/after-call`, `prompt/assemble`, `loop/before-request`, `loop/compact`

A plugin looks like this:

```ts
import { definePlugin } from "flavor-lite";

export const myPlugin = definePlugin({
  name: "my-plugin",
  inject: ["hooks", "tools"],    // load order is derived from this
  apply(ctx) {
    return ctx.effect(() => {
      const dispose = ctx.get("hooks").hook("tools/before-call", async (event, next) => {
        ctx.logger.info(`tool ${event.toolCall.name} starting`);
        return next(event);
      });
      return dispose; // everything unwinds on runtime.dispose()
    }, "my-plugin.install");
  },
});
```

Mount it via `createAgent({ plugins: [{ plugin: myPlugin }] })` or build your
own stack with `Runtime.create().use(...).start()`.

### Disk plugins (hot reload)

No SDK import needed: drop a plugin directory into `.flavorlite/plugins/`
(project) or `~/.flavorlite/plugins/` (user-global) and it is discovered at
startup. Each directory holds a `flavor-plugin.json` manifest and an ESM
entry whose default export is a plain plugin object — full contract in
[`docs/plugin-dev.md`](docs/plugin-dev.md).

```text
› /plugin new my-plugin     scaffold a plugin dir from the template
› /plugin reload my-plugin  edit index.js, hot reload — no restart
› /plugin list              load status; broken plugins are isolated as "error"
```

Coding agents: the `create-flavor-plugin` skill (`.flavorlite/skills/`)
teaches this workflow, so an agent can develop and hot-load a compliant
plugin end to end.

## Usage

| Command | Effect |
|---|---|
| `/help` | list commands |
| `/init` | explore the project and write `.flavorlite/FLAVOR.md` |
| `/model [provider:model]` | show or switch model |
| `/permissions [mode]` | show or switch permission mode |
| `/sessions`, `/resume [id]`, `/new` | session management |
| `/plugin list`, `/plugin reload [name]`, `/plugin new <name>` | disk plugin management with hot reload |
| input while running | becomes a **steering** message for the next model request |
| `Ctrl+C` while running | aborts the current turn (second press exits) |

Permission modes: `plan` (read-only) → `default` (ask per category) →
`acceptEdits` → `bypass`. Hard-dangerous commands (`rm -rf /`, `mkfs`, fork
bombs, ...) are blocked in **every** mode.

Configuration merges from (low → high): `~/.flavorlite/config.json`,
`.flavorlite/flavor.json`, environment / `.env`, CLI flags — see `.env.example`.

## Development

```bash
npm test          # 304 tests: kernel (42), loop, permission, session, compaction,
                  # plus disk plugins, router, memory, error-monitor, subagent,
                  # skill-distiller, task-planner, evolve, ...
npm run typecheck # strict + noUncheckedIndexedAccess
npm run build     # tsup → dist/ (index + cli)
```

Requirements: Node 20+. See [CHANGELOG.md](CHANGELOG.md) for release notes.
