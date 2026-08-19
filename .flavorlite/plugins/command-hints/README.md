# command-hints

Slash-command completion for the flavor-lite interactive REPL.

While you type, the moment the input line starts with `/`, matching
candidates are rendered below the line with the typed prefix highlighted.
Press **Tab** to complete the line to the next insertable candidate
(press Tab repeatedly to cycle), then Enter to run it.

## Candidates

| Source | Shown as | Tab inserts |
|---|---|---|
| Registered commands (host + plugins) | `/name` + description | `/name` (e.g. `/re` → `/remember`) |
| Discovered plugins | `name` + `plugin — …` | `/plugin reload <name>` |
| Discovered skills | `name` + `skill — …` | nothing (informational) |

Example — typing `/re`:

```
› /re
  /remember  Manually store a durable fact: /remember <type> <text>
  /resume    Resume a session by id (/resume <id>)
```

The `re` letters of each match are highlighted (bold/cyan) on a TTY.

## How it works

The terminal UI is owned by the host, not by this plugin. The host exposes a
`repl` service (`src/host/completions.ts`) while the REPL is running; this
plugin registers a `CompletionProvider` that gathers candidates from the
`commands`, `pluginsLoader` and `skills` services. Under one-shot mode
(`flavor-lite -p "…"`) there is no REPL, so the plugin no-ops gracefully.

## Configuration

None. Limit the visible list with the host's `ReplCompletions` option
`maxSuggestions` (default 8).

## Development

- Edit `index.js`, then run `/plugin reload command-hints` in the REPL.
- `collectSuggestions` is exported and covered by `tests/completions.test.ts`.
