# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
