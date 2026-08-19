# clear-context

A flavor-lite plugin that adds the `/clear` slash command.

## What it does

`/clear` does two things:

1. **Clears the terminal screen** (ANSI escape sequence).
2. **Resets the conversation context** — the model no longer sees any
   messages that existed before the command ran. The current session file is
   rewritten to keep only its header, and a `loop/before-request` listener
   trims pre-clear messages from every outgoing request, so the old context
   stays invisible for the rest of the session.

## Install

```text
/plugin list            # status: clear-context should be loaded
/plugin reload clear-context   # after editing, no restart needed
```

Discovery roots: `<project>/.flavorlite/plugins/` and `~/.flavorlite/plugins/`.

## Usage

```text
/clear
```

The prompt is redrawn on the cleared screen and the conversation continues
with a fresh context. Messages after `/clear` accumulate normally; only the
pre-clear history is forgotten (it is also removed from the session file).

## Notes

- The REPL's in-memory session handle cannot be replaced by a plugin, so the
  listener trims by message count at request time. If the in-memory history
  is already shorter than the count recorded at clear time (for example after
  `/resume` re-reads the rewritten file), nothing is trimmed — all present
  messages are post-clear conversation.
- Session-file rewriting is best-effort; if it fails, the request-time trim
  still keeps the old context away from the model.
