# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-21

### Added

- Plugin ABI v1 manifests with activation profiles, service/executable/env
  requirements, Node/platform compatibility, resource budgets, lifecycle
  state, self-tests, and operator-facing `doctor`, `explain`, and `config`.
- Evidence-backed run evaluation, structured tool diagnostics and artifacts,
  prompt/tool-output budgets, and inspectable runtime diagnostics.
- Isolated subprocess execution plus a capability broker for generated
  plugins; generated code is never imported into the host process.
- Content-addressed plugin snapshots, atomic targeted hot reload, in-flight
  tool leases, and automatic preservation of the last working version.
- Versioned/redacted telemetry with deterministic projections, bounded
  evolution budgets and circuit breaking, lifecycle quarantine, decay, and
  asset governance for generated skills and plugins.
- A dependency-free stdio MCP bridge and a fixture-based coding-agent eval
  runner with persistent JSONL results.

### Changed

- Disk-plugin discovery is now genuinely lazy: dynamic and manual entries are
  validated from their manifests without importing code until activation.
- System prompts are priority-budgeted and expose section-level inspection;
  oversized tool results keep concise transcript summaries and artifact refs.
- Verification gates emit machine-checkable evidence, and run success is
  derived from required evidence instead of completion text alone.

## [0.2.0] - 2026-08-20

### Added

- **Trusted evolution episodes** — every proposed improvement now moves through
  an explicit `implemented → verified → canary → accepted` lifecycle. Focused
  regression commands must capture a failing baseline before verification, and
  acceptance requires clean canary runs that exercise the affected capability.
- **Run-level attribution** — agent runs, tool calls, reflections, skill usage,
  and promotion evidence carry exact run/session identifiers, preventing
  concurrent agents and overlapping sessions from contaminating one another's
  learning data.
- **Structured evolution rules** — prompt improvements are stored with stable
  IDs, provenance, confidence, hit metadata, and active state while retaining a
  readable Markdown mirror.
- **Evolution operations** — `/evolve episodes`, `/evolve baseline`,
  `/evolve test`, `/evolve done`, and `/evolve dismiss` expose the verification
  and acceptance workflow to operators.
- **Generated-plugin safeguards** — generated plugins receive source auditing
  plus a time-bounded, permission-restricted child-process preflight that
  executes activation and disposal before host loading.
- **Trust-loop specification** — added `docs/specs/evolve-trust-loop.md`
  describing attribution, signal handling, verification, canary acceptance,
  skill evidence, router learning, and generated-code governance.

### Changed

- Failure suggestions now distinguish deliberate probes, transient failures,
  policy failures, and actionable defects; recurrence thresholds use distinct
  runs and rank by both frequency and recency.
- Success-pattern mining excludes generic tool-only sequences and records
  argument-shape signatures without retaining argument values.
- Router trigger learning now requires minimum support and precision, preserves
  authored keywords, removes degraded learned tokens, caps learned additions,
  and records its decisions for audit.
- Skill promotion is based on successful runs that actually read a `SKILL.md`;
  knowledge promotion and skill distillation are run-scoped, provenance-aware,
  and concurrency-safe.
- Generated evolution plugins use collision-resistant names tied to their
  source suggestion, and all generated artifacts retain provenance metadata.

### Fixed

- Verification failures and canary regressions now reject the episode, disable
  its prompt rule or unload its generated plugin, and reopen the source
  suggestion instead of recording an unverified improvement as complete.
- Reflection metrics now measure failure-rate deltas correctly and deduplicate
  failed tools within a run.
- Cross-platform verification commands now use the native Windows or POSIX
  command shell with guarded timeout settlement.

## [0.1.4] - 2026-08-19

### Added

- **evolve: SFT export (`/evolve export [limit]`)** — clean fine-tune
  trajectories from real sessions. Reads the optional `session` service (absent
  → graceful `no session service available`), keeps only `user`/`assistant`
  string messages, drops `[steering]`/`[system]` meta, truncates each message
  at 20000 chars, skips sessions with fewer than 4 clean messages, and
  overwrites `.flavorlite/evolve/sft.jsonl` (one `{sessionId, exportedAt,
  messages}` record per line). Read-only over session storage; `/evolve clear`
  never deletes the export.
- **evolve: trigger write-back (`/evolve learn`)** — turns confirmed router
  recall feedback (`.flavorlite/router-memory.json`, `used: true/false` per
  plugin fingerprint) into deterministic L0 manifest keywords: tokens score +1
  on used recalls and −1 on unused ones; candidates scoring ≥ 1 (length ≥ 2)
  are merged into each plugin's `triggers.keywords` (case-insensitive dedupe,
  cap 16, 2-space JSON preserved, idempotent, fail-safe per plugin).
- **evolve × error-monitor signal link** — `/evolve suggest` and
  `evolve_improve` now consume error-monitor's high-confidence LLM analyses
  (`.flavorlite/error-monitor/records.json`, `analysis` present and
  `confidence >= config.emConfidence` default 0.7), surfaced as
  `[em:<id>] (analyzed error)` entries and closable via `done.json` — file-level
  integration, the error-monitor plugin is untouched.
- **skill-distiller: promotion ladder (`/distill promote <slug>`)** — the
  human gate of the generated → curated rung: rewrites front-matter to
  `generated: false` + `promoted: true` + `promotedAt`, so the skill leaves the
  generation quota and becomes protected from `/distill rm`; the list shows
  `(promoted)`. Non-generated skills are refused.
- **knowledge-promoter plugin (new)** — the memory → skill → plugin promotion
  ladder, deterministic with no LLM dependency: repeated memory topics
  (`memoryTopicThreshold`, default 3) are proposed as skills
  (`/ladder to-skill <topic>`, drafts a `generated: true` + `promotedFrom:
  memory` SKILL.md), and skills mentioned in ≥ `skillUsageThreshold` (default 3)
  finished runs are proposed as plugins (`/ladder to-plugin <slug>`, scaffolds
  the plugin dir with a PLAN.md carrying the skill body). Proposals surface via
  a `knowledge-promoter` prompt section and `/ladder`; acted-on subjects are
  marked done and never re-proposed.
- **Specs** — `docs/specs/evolve-batch2.md` (export / promote / learn / signal
  link) and `docs/specs/knowledge-promoter.md` (promotion ladder), both SDD +
  TDD.

### Changed

- `evolve_improve` and `/evolve suggest` suggestion pool now spans failure
  signals, success-trigram tool proposals, and analyzed error-monitor records;
  `evolve_improve`'s `tool` field drives both `kind=plugin` and
  `kind=prompt_rule` paths for `em:` entries.

## [0.1.3] - 2026-08-19

### Added

- **evolve: `prompt_rule` fix kind** — `evolve_improve` now honors
  `kind=prompt_rule`: instead of scaffolding a plugin, the fix is normalized,
  deduplicated, and appended to `.flavorlite/evolve/rules.md`. The
  `prompt/assemble` hook injects a "self-improvement rules" section into the
  system prompt whenever the file is non-empty.
- **evolve: success-trigram tool proposals** — successful tool calls are
  buffered per run (names only, never values); `loop/after-run` mines each
  run's sequence into trigrams stored in `patterns.jsonl` (counted once per
  run). A trigram recurring across runs (default threshold 3) surfaces as a
  `(tool proposal)` suggestion alongside failure-based ones.
- **skill-distiller plugin** — the generation side of skills: after a run
  that finished with at least `minToolCalls` (default 8) tool calls, the
  session transcript is sent to the LLM for a strict-JSON SOP proposal (or
  `{"skip": true}`). Reusable workflows are written to
  `.flavorlite/skills/<slug>/SKILL.md` marked `generated: true` and are
  auto-discovered by the skills plugin. Bounded and reversible: capped at
  `maxGenerated` (default 20), existing slugs are never overwritten, and
  `/distill rm <slug>` only removes generated skills (human skills are
  protected).
- **task-planner persistence** — new `plan_end` tool archives the finished
  plan (goal, final task states, outcome, timestamps) to
  `.flavorlite/task-planner/plans.jsonl` and clears the board; new
  `/plan-log [n]` command lists recent archives; `plan_start` now records
  `startedAt`.
- **Self-evolution specs** — `docs/specs/` (`evolve-enhance.md`,
  `skill-distiller.md`, `task-planner-persistence.md`) and the roadmap in
  `docs/self-evolve.md`.

### Changed

- `evolve_improve` resolves suggestions across failure signals and pattern
  proposals; `/evolve suggest` merges both kinds, marking proposals as
  `(tool proposal)`.

## [0.1.2] - 2026-08-18

### Added

- **Typed kernel errors** — `KernelError` base with a stable `code` plus
  structured `detail`: `resolution/*`, `activation/*`, `service/ownership`,
  `service/undeclared`, `reload/*`, `unmount/dangling-consumers`,
  `kernel/limit-exceeded`, `runtime/disposed`.
- **Service ownership** — every `ctx.provide()` is owned by the activating
  plugin (propagated via `AsyncLocalStorage`); cross-plugin shadowing fails
  unless `{ override: true }` is passed.
- **Declared `provides` contract** — a plugin listing `provides` may only
  register those keys; anything else fails activation (`service/undeclared`).
- **Atomic reload** — `runtime.reload()` pre-activates the replacement and
  then hands over the old registrations; consumers never see a service gap,
  and a failed replacement leaves the old instance untouched.
- **Bounded async activation** — async `apply()` with `activationTimeoutMs`
  and `teardownTimeoutMs`; activations roll back as a batch; lazy disposers
  prevent double teardown.
- **Kernel event bus** — `runtime.on()` for lifecycle events
  (`plugin:activating|activated|failed|unmounted`, `batch:rolled-back`,
  `service:provided|removed`, `runtime:disposed`).
- **Resource caps** — optional `maxEffects` / `maxServices` /
  `maxListenersPerEvent` fail loud at registration
  (`kernel/limit-exceeded`).
- **Late-service wait** — `ctx.whenAvailable(key, signal?)` resolves now or
  when a dynamic plugin mounts the service.
- **Observability** — `runtime.inspect()` snapshots, `runtime.plan()`
  topological preview, structured log fields, effect stack traces.
- **Standard Schema v1 config validation** — plugin `config` is validated
  before `apply()`; failures raise `activation/invalid-config`.
