# command-hints

Interactive below-line completion is disabled by default because the current
host cursor-restoration implementation can leave the input cursor at the end
of a suggestion row. Use `/hints [prefix]` for safe discovery. Set manifest
config `interactive: true` only with a host that resets to column one before
restoring the input cursor.

Command, plugin and skill discovery for the flavor-lite interactive REPL.

Run `/hints [prefix]` to print matching candidates as ordinary command output.
Interactive suggestions and Tab completion remain available behind
`config.interactive: true` for corrected/custom hosts.

## Candidates

| Source | Shown as | Tab inserts |
|---|---|---|
| Registered commands (host + plugins) | `/name` + description | `/name` (e.g. `/re` → `/remember`) |
| Discovered plugins | `name` + `plugin — …` | `/plugin reload <name>` |
| Discovered skills | `name` + `skill — …` | nothing (informational) |

Example:

```
› /hints re
  /remember  Manually store a durable fact: /remember <type> <text>
  /resume    Resume a session by id (/resume <id>)
```

## How it works

The terminal UI is owned by the host, not by this plugin. The host exposes a
`repl` service (`src/host/completions.ts`) while the REPL is running; this
plugin gathers candidates from the `commands`, `pluginsLoader` and `skills`
services. In safe mode it registers only `/hints`; interactive mode also
registers a `CompletionProvider` through the host's `repl` service.

## Configuration

`interactive` defaults to `false`. Set it to `true` only when the host resets
horizontal cursor origin before restoring the readline input position.

## Development

- Edit `index.js`, then run `/plugin reload command-hints` in the REPL.
- `collectSuggestions` is exported and covered by `tests/completions.test.ts`.
