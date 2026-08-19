# error-monitor

A flavor-lite plugin that watches for **erroneous tool calls** — wrong
arguments, unknown tools, network/link failures, and especially failing
Windows shell commands — records them, has the **background LLM analyze
each new failure**, and stores only **high-confidence analyses** in
long-term memory to guide future tool calls.

## What it does

1. **Monitor** — a `tools/after-call` hook inspects every tool result.
   Only calls whose result carries `isError: true` are considered. Successful
   results are ignored.
2. **Record with deduplication** — failures are stored under
   `.flavorlite/error-monitor/records.json`. Each record is keyed by a
   signature derived from the tool name, error kind, shell command (when
   present) and normalized error text. Repeating the same failure does **not**
   create a new record — it only bumps the `count`/`lastAt` fields.
3. **LLM analysis with confidence** — for every *new* failure the plugin
   calls the background LLM (the same `llm` service the agent uses) with:
   - the tool name and classified error kind
   - the shell command / arguments
   - the redacted error text
   - the runtime environment: `platform`, `arch`, `node`, `shell`
     (e.g. `cmd.exe` on Windows), `cwd`

   The LLM replies with strict JSON:
   `{"analysis": "<actionable lesson>", "confidence": <0.0-1.0>}`.
   Only analyses whose confidence is at or above `llm.confidenceThreshold`
   (default **0.7**) are distilled into long-term memory. Low-confidence
   analyses stay in the local record (with their score) but are not
   memorized.
4. **Store in long-term memory** — the accepted analysis is saved as a
   `feedback`-type memory (task `tool-errors`) via the
   [memory plugin](../memory/). The memory plugin's own similarity dedupe
   rejects near-duplicate lessons, and hybrid recall surfaces them when
   relevant in later runs.
5. **Guide future tool calls** — a `prompt/assemble` hook injects the most
   recent lessons into the system prompt, so the model sees past failures
   before it plans its next tool calls. When an LLM analysis exists it
   leads over the rule-based lesson: it is the distilled insight actually
   written to long-term memory.
6. **Diagnose every outcome** — hosts commonly run with a silent logger,
   so every distillation outcome is persisted on the record itself as
   `memoryStatus`: `stored`, `stored (rule-based fallback)`, or
   `skipped:<reason>` (low confidence, LLM failure, duplicate, no memory
   service, ...). `/errors` prints it per record.

The LLM analysis runs **in the background** (it never blocks the tool loop),
is aborted after `llm.timeoutMs` (default 20s) so a slow or hung provider
cannot stall the agent, and is retried `llm.retryCount` times (default 2)
on transient failures — empty replies, dropped streams, timeouts. Retries
wait with **exponential backoff** (`retryBackoffMs`, doubled per attempt):
an immediate retry usually lands in the same provider failure window.
Distillations are also **serialized** — bursting several analysis streams
at the gateway at once is exactly when it tends to answer with empty
replies, so they run one at a time.

### Without an LLM service

If no `llm` service is mounted (or the analysis call fails), **nothing is
written to long-term memory by default** — the failure is still recorded in
`.flavorlite/error-monitor/records.json` for `/errors` inspection. Only when
`fallbackToRules: true` is set explicitly does a compact rule-based lesson
get stored instead. This guarantees that memory entries come only from
successful LLM analyses (or an explicit opt-in to rule fallback).

## Error kinds

| kind | typical signal |
| --- | --- |
| `shell_exit` | `[exit code: N]` (non-zero), e.g. `'x' is not recognized...` on cmd.exe |
| `shell_spawn` | `[spawn error]` — process could not be started |
| `shell_timeout` | `[killed after Nms timeout]` |
| `tool_not_found` | `Tool "x" not found. Available tools: ...` |
| `tool_blocked` | call rejected by policy |
| `invalid_args` | missing/invalid arguments |
| `network` | fetch failed, ECONNREFUSED, ENOTFOUND, timeouts, ... |
| `file` | ENOENT, EACCES, "No such file or directory", ... |
| `unknown` | everything else |

## Commands

- `/errors` — list recorded errors (kind, tool, command, occurrence count,
  last seen, lesson, LLM analysis/confidence, and the `memory:` status
  explaining whether — and why — a lesson reached long-term memory).
- `/errors clear` — empty the local error log. Long-term memory lessons are
  intentionally kept.
- `/errors analyze` — re-run the LLM distillation for every record that has
  no analysis yet (e.g. after a stretch of transient provider failures
  returned empty replies). Runs in the background; check `/errors` shortly
  after for the results.

### Why is nothing in memory?

The REPL runs with a silent logger by default, so distillation decisions
are not printed. Run `/errors` instead: each record shows a `memory:` line
with the exact outcome, e.g.

```
memory: stored
memory: skipped: confidence 0.40 < threshold 0.7
memory: skipped: LLM analysis failed (Request timed out); set fallbackToRules ...
```

Common remedies: raise `llm.timeoutMs` for slow providers, lower
`llm.confidenceThreshold`, or set `fallbackToRules: true`. When records
show `LLM analysis failed (empty)` — the gateway returned zero tokens,
a transient condition — run `/errors analyze` to re-distill them.

With **reasoning models** (e.g. `deepseek-v4-flash`) the chain-of-thought
consumes the whole token budget and leaves the answer empty; the plugin
sends `thinking: "disabled"` for exactly this reason. If your provider
ignores that hint, point `llm.model` at a non-reasoning model instead.

## Configuration

Edit `config` in `flavor-plugin.json` (or pass a config object when
mounting the plugin programmatically):

```jsonc
{
  "maxRecords": 200,          // keep at most this many records
  "maxDetailChars": 500,      // stored error detail length cap
  "maxLessonChars": 560,      // lesson length cap (memory entry limit is 600)
  "maxPromptLessons": 4,      // how many lessons appear in the system prompt
  "maxPromptChars": 1200,     // system-prompt section length cap
  "ignorePatterns": [],       // regex sources; matching error text is skipped
  "enabled": true,            // set false to pause monitoring
  "llm": {
    "enabled": true,          // set false to disable LLM analysis
    "model": "",              // "provider:model"; empty = default model
    "confidenceThreshold": 0.7, // minimum confidence to memorize an analysis
    "maxTokens": 800,
    "maxAnalysisChars": 500,
    "thinking": "disabled",   // skip reasoning-model chain-of-thought (DeepSeek v4/flash)
    "timeoutMs": 20000,       // abort the analysis LLM call after this long
    "retryCount": 2,          // extra attempts on transient failures
    "retryBackoffMs": 1500,   // first retry delay (doubled per attempt)
    "includeArgs": true,      // include tool arguments in the analysis prompt
    "includeEnv": true        // include platform/node/shell/cwd in the prompt
  },
  "fallbackToRules": false    // opt-in: rule-based lesson when LLM fails (default: memory stays empty)
}
```

`ignorePatterns` is useful for known-benign failures (e.g. commands that
return non-zero by design, like `grep` finding nothing):

```jsonc
{ "ignorePatterns": ["no match found", "nothing to commit"] }
```

## Safety

- Secrets are redacted from stored details, commands, lessons, **and from
  everything sent to the LLM** (`api_key=...`, tokens, private keys).
- The analysis prompt never includes environment-file contents — only
  platform/shell/node/cwd metadata.
- Writes go through a temp-file rename, so a crash cannot corrupt the log.
- All hooks fail softly: an analysis failure never breaks the tool loop or
  the prompt assembly, and never writes to memory unless `fallbackToRules`
  was opted into.
- Only erroneous calls are processed; nothing is recorded for successful
  tool results.

## Files

- `index.js` — plugin wiring (after-call capture, distillation, prompt
  section, `/errors`)
- `records.js` — self-contained record store, classification, and
  rule-based lesson builder (unit-testable without a runtime)
- `analyze.js` — LLM prompt builder, environment info, and strict-JSON
  confidence parsing (unit-testable without a runtime)
