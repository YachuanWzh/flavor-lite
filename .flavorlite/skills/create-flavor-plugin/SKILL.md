---
name: create-flavor-plugin
description: Create or modify a flavor-lite kernel plugin (.flavorlite/plugins) with hot reload. Use when the user wants to add tools, slash commands, prompt sections, hooks, or model providers to this agent.
---

# Create a flavor-lite plugin

flavor-lite is "everything is a plugin": extend the agent by dropping a
plugin dir into `.flavorlite/plugins/` — never by editing `src/`.

## Authoritative spec

Read `docs/plugin-dev.md` first (repo root). This card is the workflow; the
spec has the full contract, service table, and hook table.

## Workflow

1. Scaffold: run `/plugin new <name>` in the REPL, or create
   `.flavorlite/plugins/<name>/` manually with `flavor-plugin.json` +
   `index.js` (see minimal shape below).
2. Implement in `index.js`: plain ESM, `export default { name, inject?, provides?, apply(ctx, config) }`.
   - Register effects inside `ctx.effect(...)` and return a disposer that
     undoes ALL of them (reverse order).
   - `inject` lists SERVICE KEYS (`hooks`, `tools`, `commands`, `llm`,
     `permission`, `session`, `agent`, `systemPrompt`, `skills`) — never
     plugin names. The loop's service key is `agent`, not `loop`.
   - Tools: `ctx.get("tools").register({...})`; commands:
     `ctx.get("commands").register({...})`; prompt sections via the
     `prompt/assemble` hook; policies via `tools/before-call`.
3. Activate: `/plugin reload <name>` (or `/plugin reload` for full
   re-discovery including brand-new dirs). No restart needed.
4. Verify: `/plugin list` must show `loaded`; fix anything `error` reports.
   For tools, ask the model to call it or use `loop/before-request` only as
   a last resort.

## Minimal shape

```text
.flavorlite/plugins/<name>/flavor-plugin.json
{ "name": "<name>", "version": "0.1.0", "entry": "index.js" }
```

```js
// .flavorlite/plugins/<name>/index.js
export default {
  name: "<name>",
  inject: ["commands"],
  apply(ctx) {
    return ctx.effect(
      () => ctx.get("commands").register({
        name: "<name>",
        description: "What it does",
        run: () => "ok",
      }),
      "<name>.install",
    );
  },
};
```

## Rules

- Never throw from `execute()` of a tool — return `{ content, isError: true }`.
- Every registration must be reversible: unmount runs your disposer.
- Plugin `name` and tool/command names must be globally unique.
- No npm install: vendor dependencies inside the plugin dir.
- Pass per-plugin settings via the manifest `config` field, read from
  `apply(ctx, config)`.
