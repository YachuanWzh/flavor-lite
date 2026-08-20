# hallucination-detector

Full-lifecycle hallucination audit for flavor-lite agent runs.

Instead of judging only the final answer, the plugin treats the agent as a
perceive → plan → act → reflect closed loop and attributes every signal to a
lifecycle stage:

| Stage             | Checks                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| tool-execution    | repeat-window loops (same tool + sorted-args hash ≥ threshold times in a sliding window), flip-flop edits, ignored failures, misread results |
| input-planning    | LLM-as-a-Judge: did the run actually satisfy the user request? (optional)                |
| reasoning         | self-contradicting statements across the run                                             |
| memory-state      | context compaction decay, mid-run steering drift                                         |
| process           | redundant exploration (same read 3× in a row), dead-end check chains                     |
| output-grounding  | files/commands claimed in the final answer without evidence in the trace                 |

## How it runs

- `loop/after-run` hook: after every finished run with at least `minToolCalls`
  tool calls, replays the latest session transcript and writes a report to
  `.flavorlite/hallucination/reports.jsonl` (plus a `hallucination.audit`
  event into the telemetry feed when mounted). Fire-and-forget; never blocks
  or breaks the loop.
- The repeat-window rule hashes each call as `sha1(toolName + "|" +
  JSON.stringify(key-sorted args))` and flags hashes reaching
  `repeat.threshold` occurrences within `repeat.windowSize` calls
  (default: 10-in-20).

## Commands

```
/hallucination            # show the latest audit report
/hallucination show [n]   # list the n most recent audits (one line each)
/hallucination now        # audit the latest session right now
/hallucination clear      # delete all stored reports
```

## Verdicts

`score` is a weighted severity sum (low=1, medium=3, high=8, capped at 100):

- `clean` — no signals
- `suspect` — score 1–11
- `likely-hallucinated` — score ≥ 12 (one high-severity signal plus correlated
  medium/low signals, or several mediums)

## Config (flavor-plugin.json `config`)

- `enabled` (true) — master switch
- `autoAudit` (true) — audit automatically after each finished run
- `minToolCalls` (1) — skip smaller runs
- `repeat.windowSize` (20) / `repeat.threshold` (10) — repeat-window rule
- `judge.enabled` (true) — LLM judge for intent alignment (needs an llm service)
- `judge.model` — optional `provider:model` override
- `maxReports` (200) — rolling cap of stored reports

## Service

The plugin provides `hallucination` with `audit(sessionId?)`, `latest()`,
`list()`, `clear()` and `idle()` (waits for pending fire-and-forget audits).

## Notes

- Heuristics are lexical/structural by design — fast and dependency-free.
  False positives are possible (e.g. "contradiction"); use the stage
  attribution to drill down before acting on a report.
- The judge prompt only contains the user request, bounded tool evidence and
  the final answer — no secrets, no full transcripts.
