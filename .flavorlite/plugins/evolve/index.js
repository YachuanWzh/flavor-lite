// evolve — bounded recursive self-improvement for flavor-lite.
//
// RSI in one closed loop, kept deliberately bounded and human-gated:
//   1. CAPTURE  tools/after-call records failing tool results into a
//                deduped signal store (tool + normalized error), and
//                buffers successful call names so recurring workflows
//                (trigrams across runs) can be mined into tool proposals.
//   2. ASSESS   prompt/assemble surfaces open suggestions (fixes and tool
//                proposals) plus distilled rules.md rules in the system
//                prompt; the model decides whether any code/tool change
//                would fix the repeated failure.
//   3. MODIFY   the /evolve suggest command hands the model's proposal back
//                to the running agent, which implements it via the normal
//                tool loop (Write/Edit + hot reload). The evolve_improve
//                tool scaffolds the fix dir (kind=plugin) or distills a
//                permanent prompt rule (kind=prompt_rule).
//   4. VERIFY   /evolve verify <name> sandbox-dry-runs the plugin on a
//                shadow runtime BEFORE activation; /evolve test runs the
//                suite afterwards — green runs are genuine capability gains
//                (passing tests, not the model's say-so). Bad versions can
//                be undone with /evolve revert <name> (loader snapshots).
//   5. REPEAT   suggestions accumulate across runs; each acted-on id is
//                marked done so the same fix is not proposed again. Run
//                reflections carry tool/error stats and a real signalDelta,
//                so improvement is measurable across runs.
//
// The loop is never fully autonomous: suggestions are *proposals* surfaced
// to the user, and modifications run through the normal permission system
// (tools/before-call), so the agent cannot self-edit outside its grant.
//
// Note on `config`: the kernel validates a plugin's `config` field as a
// Standard Schema v1 object (with `~standard.validate`), NOT as JSON Schema.
// Disk plugins cannot depend on zod, so we declare no `config` field at all;
// the manifest `config` object is passed straight through as apply()'s
// second argument.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EvolveStore } from "./store.js";

const DEFAULT_PROMPT_TOP = 3;
const MIN_REPEATS = 2;
const PATTERN_THRESHOLD = 3;
const DEFAULT_PATTERN_TOP = 2;
const TEST_TIMEOUT_MS = 120000;
const DEFAULT_EXPORT_LIMIT = 20;
const MAX_CONTENT_CHARS = 20000;
const MIN_EXPORT_MESSAGES = 4;
const DEFAULT_EM_CONFIDENCE = 0.7;
const MAX_TRIGGER_KEYWORDS = 16;
const DEFAULT_LEARN_MIN_SUPPORT = 3;
const DEFAULT_LEARN_MIN_PRECISION = 0.75;
const DEFAULT_CANARY_RUNS = 3;
const GENERIC_PATTERN_TOOLS = new Set(["read", "grep", "glob", "shell", "write", "edit", "todowrite"]);

const SUGGEST_SECTION = `# self-improvement suggestions (evolve plugin)

Repeated tool failures are accumulating in .flavorlite/evolve/. If one of the
suggestions below has an obvious, low-risk fix (e.g. a better prompt section,
a plugin, a memory rule, a tool wrapper, or a safer default), implement it in
this session when it is in scope; otherwise ignore them. Never act on them
without running the test suite afterwards.

{{SUGGESTIONS}}
`;

const RULES_SECTION = `# self-improvement rules (evolve plugin)

Rules below were distilled from past fixes and always apply:

{{RULES}}
`;

/** Sanitize a tool name into a valid fix-plugin dir name (letters/digits/-/_). */
function sanitizePluginName(tool) {
  const base = String(tool ?? "fix").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return base.startsWith("fix-") ? base : `fix-${base}`;
}

/**
 * Read error-monitor records carrying a high-confidence LLM analysis. This is
 * the signal link between the two plugins: error-monitor does the deep
 * analysis, evolve turns confirmed insights into actionable suggestions.
 * Tolerant read — a missing/corrupt log simply means no analyzed errors.
 */
async function readAnalyzedErrors(cwd, minConfidence) {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    return records
      .filter((record) => typeof record?.analysis === "string" && record.analysis.trim() !== "")
      .filter((record) => (typeof record.confidence === "number" ? record.confidence : 1) >= minConfidence)
      .map((record) => ({
        id: `em:${record.id}`,
        tool: record.tool,
        kind: record.kind ?? "unknown",
        count: record.count ?? 1,
        error: record.analysis,
      }));
  } catch {
    return [];
  }
}

/** Run one command with output capture; never throws. */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { file: "/bin/sh", args: ["-lc", command] };
    const child = spawn(shell.file, shell.args, {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr: `${stderr}\n[killed: exceeded ${timeoutMs}ms]`, code: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: `${stderr}\n${error.message}`, code: "spawn" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export default {
  name: "evolve",
  version: "0.2.0",
  description: "bounded recursive self-improvement: capture repeated failures, propose plugin-level fixes, verify with tests",
  provides: ["evolve"],
  inject: ["hooks", "tools", "commands", "pluginsLoader"],

  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const promptTop = Number.isFinite(config.promptTop) ? config.promptTop : DEFAULT_PROMPT_TOP;
      const minRepeats = Number.isFinite(config.minRepeats) ? config.minRepeats : MIN_REPEATS;
      const patternThreshold = Number.isFinite(config.patternThreshold) ? config.patternThreshold : PATTERN_THRESHOLD;
      const patternTop = Number.isFinite(config.patternTop) ? config.patternTop : DEFAULT_PATTERN_TOP;
      const testCommand = typeof config.testCommand === "string" && config.testCommand.trim() !== ""
        ? config.testCommand
        : "npm test";
      const testTimeoutMs = Number.isFinite(config.testTimeoutMs) ? config.testTimeoutMs : TEST_TIMEOUT_MS;
      const exportLimit = Number.isFinite(config.exportLimit) ? config.exportLimit : DEFAULT_EXPORT_LIMIT;
      const emConfidence = Number.isFinite(config.emConfidence) ? config.emConfidence : DEFAULT_EM_CONFIDENCE;
      const learnMinSupport = Number.isFinite(config.learnMinSupport) ? config.learnMinSupport : DEFAULT_LEARN_MIN_SUPPORT;
      const learnMinPrecision = Number.isFinite(config.learnMinPrecision) ? config.learnMinPrecision : DEFAULT_LEARN_MIN_PRECISION;
      const canaryRuns = Number.isFinite(config.canaryRuns) ? Math.max(1, config.canaryRuns) : DEFAULT_CANARY_RUNS;
      const verificationCommands = Array.isArray(config.verificationCommands)
        ? config.verificationCommands.filter((command) => typeof command === "string" && command.trim())
        : [testCommand, "npm run typecheck", "npm run build"];

      const store = new EvolveStore({ cwd: ctx.cwd });
      const disposers = [];
      // Success-call names of the current run (values never recorded);
      // flushed into trigram patterns on loop/after-run.
      const recentCalls = new Map();
      const failedCalls = new Map();
      const legacyRunId = "legacy";

      // Service: exposes the store for other plugins and the tools below.
      disposers.push(
        ctx.provide("evolve", {
          store,
          suggestions: () => store.openSuggestions({ threshold: minRepeats, limit: promptTop }),
          describe: async () => {
            const signals = await store.signals();
            const open = await store.openSuggestions({ threshold: minRepeats, limit: 100 });
            return [
              `signals: ${signals.length} (open suggestions: ${open.length})`,
              `latest signals: ${signals
                .slice(0, 5)
                .map((signal) => `${signal.tool} x${signal.count}`)
                .join(", ") || "(none)"}`,
            ].join("\n");
          },
        }),
      );

      // CAPTURE: dedupe failing tool results into the signal store; buffer
      // successful call names so after-run can mine recurring trigrams.
      disposers.push(
        ctx.get("hooks").hook("tools/after-call", async (event, next) => {
          try {
            if (event.result?.isError === true) {
              const recorded = await store.recordSignal({
                tool: event.toolCall.name,
                args: event.args ?? event.toolCall.args,
                error: event.result.content,
                runId: event.context?.runId,
                sessionId: event.context?.sessionId,
              });
              const runId = event.context?.runId ?? legacyRunId;
              const failures = failedCalls.get(runId) ?? [];
              failures.push({ id: recorded.record.id, tool: event.toolCall.name, at: new Date().toISOString() });
              failedCalls.set(runId, failures);
            } else {
              const runId = event.context?.runId ?? legacyRunId;
              const calls = recentCalls.get(runId) ?? [];
              const keys = Object.keys(event.args ?? event.toolCall.args ?? {}).sort();
              calls.push({ name: event.toolCall.name, signature: keys.length > 0 ? `${event.toolCall.name}(${keys.join(",")})` : event.toolCall.name });
              recentCalls.set(runId, calls);
            }
          } catch (error) {
            ctx.logger.warn(`evolve: capture failed — ${error instanceof Error ? error.message : String(error)}`);
          }
          return next(event);
        }),
      );

      // ASSESS: surface open suggestions and distilled rules to the model.
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          try {
            const suggestions = await store.openSuggestions({ threshold: minRepeats, limit: promptTop });
            const proposals = await store.openPatternSuggestions({ threshold: patternThreshold, limit: patternTop });
            if (suggestions.length > 0 || proposals.length > 0) {
              const lines = suggestions.map((s) => `- [${s.id}] ${s.hint}`);
              for (const p of proposals) lines.push(`- [${p.id}] (tool proposal) ${p.hint}`);
              event.sections.push({
                name: "evolve",
                content: SUGGEST_SECTION.replace("{{SUGGESTIONS}}", lines.join("\n")),
              });
            }
            const rules = (await store.readRules()).trim();
            if (rules) {
              event.sections.push({
                name: "evolve-rules",
                content: RULES_SECTION.replace("{{RULES}}", rules),
              });
            }
          } catch (error) {
            ctx.logger.warn(`evolve: prompt section failed — ${error instanceof Error ? error.message : String(error)}`);
          }
          return next(event);
        }),
      );

      // VERIFY + REPEAT: record a run summary so improvement is measurable.
      // signalDelta compares total failure occurrences against the previous
      // reflection: negative means the fix is working, positive means regressions.
      disposers.push(
        ctx.get("hooks").hook("loop/after-run", async (event, next) => {
          try {
            // Mine this run's success sequence into trigrams. A trigram counts
            // once per run: only cross-run recurrence signals a real workflow.
            const runId = event.runId ?? legacyRunId;
            const calls = recentCalls.get(runId) ?? [];
            const failures = failedCalls.get(runId) ?? [];
            const seen = new Set();
            if (event.successful !== false && event.outcome !== "provider_error") {
              for (let i = 0; i + 3 <= calls.length; i += 1) {
                const window = calls.slice(i, i + 3);
                const names = window.map((call) => call.name);
                // Generic file/search/shell trigrams describe normal agent mechanics,
                // not a reusable domain workflow. Require at least one semantic tool.
                if (names.every((name) => GENERIC_PATTERN_TOOLS.has(name.toLocaleLowerCase()))) continue;
                const sequence = window.map((call) => call.signature);
                const key = sequence.join("->");
                if (seen.has(key)) continue;
                seen.add(key);
                await store.recordPattern({ sequence, runId: event.runId });
              }
            }
            recentCalls.delete(runId);
            failedCalls.delete(runId);

            const current = await store.signals();
            const failedTools = [...new Set(current
              .filter((signal) => (signal.count ?? 1) >= minRepeats)
              .map((signal) => signal.tool))];
            const totalFailures = current.reduce((sum, signal) => sum + (signal.count ?? 1), 0);
            const [previous] = await store.reflections(1);
            const failureRate = (event.toolCalls ?? 0) > 0 ? (event.toolErrors ?? 0) / event.toolCalls : 0;
            await store.appendReflection({
              runId: event.runId,
              sessionId: event.sessionId,
              iterations: event.iterations ?? 0,
              reason: event.reason ?? "finished",
              outcome: event.outcome,
              toolCalls: event.toolCalls ?? 0,
              toolErrors: event.toolErrors ?? 0,
              steers: event.steers ?? 0,
              totalFailures,
              failureRate,
              signalDelta: previous ? failureRate - (previous.failureRate ?? 0) : 0,
              failedTools,
            });

            // CANARY: only count runs that exercised the affected tool. A
            // recurrence reopens the suggestion; clean exposures accumulate
            // until the episode is accepted automatically.
            for (const episode of await store.episodes(200)) {
              if (episode.status !== "canary") continue;
              const sourceTool = episode.source?.tool;
              const sourceSequence = Array.isArray(episode.source?.sequence) ? episode.source.sequence : [];
              const signatures = calls.map((call) => call.signature);
              const sequenceExposed = sourceSequence.length > 0 && signatures.some((_, index) =>
                sourceSequence.every((value, offset) => signatures[index + offset] === value));
              const toolExposed = typeof sourceTool === "string"
                && (calls.some((call) => call.name === sourceTool) || failures.some((call) => call.tool === sourceTool));
              if (!toolExposed && !sequenceExposed) continue;
              const regressed = typeof sourceTool === "string"
                ? failures.some((call) => call.tool === sourceTool && String(call.at) >= String(episode.canaryStartedAt ?? ""))
                : failures.some((call) => String(call.at) >= String(episode.canaryStartedAt ?? ""));
              if (regressed) {
                if (episode.ruleId) await store.updateRule(episode.ruleId, { active: false });
                if (episode.pluginName) {
                  await ctx.get("pluginsLoader").eject(episode.pluginName).catch(() => {});
                }
                await store.updateEpisode(episode.id, "rejected", {
                  rejectedAt: new Date().toISOString(),
                  reason: `failure recurred during canary run ${event.runId ?? legacyRunId}`,
                });
                continue;
              }
              const count = (episode.canaryCount ?? 0) + 1;
              if (count >= canaryRuns) {
                await store.updateEpisode(episode.id, "accepted", { canaryCount: count, acceptedAt: new Date().toISOString() });
              } else {
                await store.updateEpisode(episode.id, "canary", { canaryCount: count, lastCanaryRunId: event.runId });
              }
            }
          } catch (error) {
            ctx.logger.warn(`evolve: reflection failed — ${error instanceof Error ? error.message : String(error)}`);
          }
          return next(event);
        }),
      );

      // MODIFY: scaffold a fix plugin dir (kind=plugin) or distill a prompt
      // rule (kind=prompt_rule) for one open suggestion, then the running
      // agent implements/verifies it with its own tools.
      disposers.push(
        ctx.get("tools").register({
          name: "evolve_improve",
          description:
            "Act on one open evolve suggestion. kind=plugin (default): scaffolds a fix plugin dir and returns " +
            "instructions for implementing, hot-reloading, and verifying it. kind=prompt_rule: distills the " +
            "implementation text into a permanent behavior rule injected into the system prompt (no plugin). " +
            "Use when the model proposes a concrete fix for a suggestion in the system prompt.",
          category: "shell",
          inputSchema: {
            type: "object",
            properties: {
              suggestionId: { type: "string", description: "Signal id from the evolve suggestions" },
              implementation: { type: "string", description: "Concise description of the fix to implement" },
              verificationCommand: {
                type: "string",
                description: "Optional focused regression command. It must fail before the change and pass after implementation.",
              },
              kind: {
                type: "string",
                enum: ["plugin", "prompt_rule"],
                description: "Fix shape: scaffold a plugin (default) or append a prompt rule.",
              },
            },
            required: ["suggestionId", "implementation"],
          },
          async execute(args) {
            const suggestionId = String(args?.suggestionId ?? "");
            const implementation = String(args?.implementation ?? "");
            const kind = args?.kind === "prompt_rule" ? "prompt_rule" : "plugin";
            const verificationCommand = typeof args?.verificationCommand === "string" ? args.verificationCommand.trim() : "";
            const doneIds = new Set(await store.readDoneIds());
            const activeIds = new Set(await store.activeSuggestionIds());
            const analyzed = (await readAnalyzedErrors(ctx.cwd, emConfidence)).filter((entry) => !doneIds.has(entry.id) && !activeIds.has(entry.id));
            const suggestions = [
              ...(await store.openSuggestions({ threshold: minRepeats, limit: 100 })),
              ...(await store.openPatternSuggestions({ threshold: patternThreshold, limit: 100 })),
              ...analyzed,
            ];
            const suggestion = suggestions.find((s) => s.id === suggestionId);
            if (!suggestion) {
              return { content: `No open suggestion with id "${suggestionId}".`, isError: true };
            }

            let baseline;
            if (verificationCommand) {
              baseline = await runCommand(verificationCommand, ctx.cwd, testTimeoutMs);
              if (baseline.ok) {
                return {
                  content: "Focused regression command already passes; refusing to claim a red-green improvement. Supply a reproducer that fails before the change.",
                  isError: true,
                };
              }
            }

            if (kind === "prompt_rule") {
              const rule = await store.appendRule(implementation, { sourceId: suggestion.id, confidence: 0.5 });
              const episode = await store.beginEpisode({
                suggestionId: suggestion.id,
                kind,
                implementation,
                source: suggestion,
              });
              await store.updateEpisode(episode.id, "implemented", { ruleId: rule?.id });
              if (verificationCommand) {
                await store.updateEpisode(episode.id, "implemented", {
                  verificationCommand,
                  baseline: { ok: false, code: baseline?.code, stderr: baseline?.stderr?.slice(-2000) },
                  ruleId: rule?.id,
                });
              }
              return {
                content: [
                  `Distilled suggestion [${suggestion.id}] into prompt rule ${rule?.id ?? "(legacy)"}.`,
                  `Rule: ${implementation}`,
                  `Episode ${episode.id} is implemented, not accepted. Run /evolve test ${suggestion.id}, then /evolve done ${suggestion.id}.`,
                ].join("\n"),
              };
            }

            const loader = ctx.get("pluginsLoader");
            const name = `${sanitizePluginName(suggestion.tool ?? suggestion.sequence?.join("-") ?? "fix")}-${suggestion.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
            let dir;
            try {
              dir = await loader.scaffold(name);
            } catch (error) {
              return {
                content: `Failed to scaffold plugin "${name}": ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
              };
            }

            // Mark the scaffold as agent-generated (provenance): the manifest
            // schema accepts origin/generatedFrom, so governance policies can
            // distinguish human-written from self-produced plugins (3.4/3.8).
            // Tolerant: a missing/unwritable manifest is not fatal.
            try {
              const manifestFile = join(dir, "flavor-plugin.json");
              const manifest = JSON.parse(await readFile(manifestFile, "utf-8"));
              manifest.origin = "generated";
              manifest.generatedFrom = suggestion.id;
              await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
            } catch {
              // manifest missing: leave provenance to the caller
            }

            const episode = await store.beginEpisode({
              suggestionId: suggestion.id,
              kind,
              implementation,
              pluginName: name,
              source: suggestion,
            });
            if (verificationCommand) {
              await store.updateEpisode(episode.id, "implemented", {
                verificationCommand,
                baseline: { ok: false, code: baseline?.code, stderr: baseline?.stderr?.slice(-2000) },
              });
            }

            // Record the implementation plan next to the scaffold so the
            // running agent (and the human) can see what was intended.
            const subject = suggestion.tool ?? suggestion.sequence?.join("->") ?? "pattern";
            try {
              await writeFile(
                `${dir}/PLAN.md`,
                [
                  "# evolve fix plan",
                  "",
                  `Suggestion: [${suggestion.id}] ${subject} x${suggestion.count}`,
                  `Error: ${suggestion.error ?? "(recurring success pattern — package the sequence as one tool)"}`,
                  "",
                  "## Implementation",
                  "",
                  implementation,
                  "",
                  "## Verification",
                  "",
                  "- implement index.js (see create-flavor-plugin skill contract)",
                  `- /evolve verify ${name} (sandbox dry-run must pass before activation)`,
                  `- /plugin reload ${name}`,
                  "- /evolve test",
                  `- /evolve done ${suggestion.id} after tests pass`,
                  `- on failure: /evolve revert ${name} restores the last good version`,
                  "",
                ].join("\n"),
                "utf-8",
              );
            } catch {
              // PLAN.md is best-effort; the scaffold itself already exists.
            }

            return {
              content: [
                `Scaffolded fix plugin at ${dir} for suggestion [${suggestion.id}] (${subject} x${suggestion.count}).`,
                `Plan written to PLAN.md.`,
                ``,
                `Now implement it yourself:`,
                `1. Write the plugin entry (index.js) per the create-flavor-plugin skill — a minimal hook or tool wrapper is enough.`,
                `2. Run /evolve verify ${name} — the sandbox dry-run must pass before activation.`,
                `3. Run /plugin reload ${name} to hot-load it.`,
                `4. Run /evolve test to verify the suite still passes.`,
                `5. Run /evolve test ${suggestion.id}; only then can /evolve done ${suggestion.id} accept it. If anything breaks, /evolve revert ${name} restores the last good version.`,
              ].join("\n"),
            };
          },
        }),
      );

      // MODIFY (operator): one-command scaffold-and-edit flow, VERIFY + cleanup.
      disposers.push(
        ctx.get("commands").register({
          name: "evolve",
          description: "self-improvement loop: suggest, improve, test",
          run: async (args) => {
            const arg = String(args ?? "").trim();
            const loader = ctx.get("pluginsLoader");

            if (arg === "signals") {
              const signals = await store.signals();
              if (signals.length === 0) return "no signals recorded yet";
              return signals
                .slice(0, 10)
                .map((s) => `[${s.id}] ${s.tool} x${s.count} — ${s.error}`)
                .join("\n");
            }

            if (arg === "suggest") {
              const suggestions = await store.openSuggestions({ threshold: minRepeats, limit: 100 });
              const proposals = await store.openPatternSuggestions({ threshold: patternThreshold, limit: 100 });
              const doneIds = new Set(await store.readDoneIds());
              const activeIds = new Set(await store.activeSuggestionIds());
              const analyzed = (await readAnalyzedErrors(ctx.cwd, emConfidence)).filter((entry) => !doneIds.has(entry.id) && !activeIds.has(entry.id));
              if (suggestions.length === 0 && proposals.length === 0 && analyzed.length === 0) {
                return "no open suggestions (need >= 2 repeats of the same failure, or a recurring success trigram)";
              }
              const lines = suggestions.map((s) => `[${s.id}] ${s.tool} x${s.count}: ${s.error}\n  fix idea: ${s.hint}`);
              for (const p of proposals) {
                lines.push(`[${p.id}] (tool proposal) ${p.sequence.join("->")} x${p.count}\n  fix idea: ${p.hint}`);
              }
              for (const entry of analyzed) {
                lines.push(`[${entry.id}] (analyzed error) ${entry.tool} x${entry.count}: ${entry.error}`);
              }
              return lines.join("\n");
            }

            if (arg === "export" || arg.startsWith("export ")) {
              const session = ctx.tryGet("session");
              if (!session) return "no session service available (session plugin not loaded)";
              const requested = arg.startsWith("export ") ? Number.parseInt(arg.slice(7).trim(), 10) : Number.NaN;
              const limit = Number.isFinite(requested) && requested > 0 ? requested : exportLimit;
              let infos = [];
              try {
                infos = await session.list();
              } catch {
                infos = [];
              }
              // Clean SFT trajectories: user/assistant only, no steering or
              // system meta, bounded content. Sessions shorter than
              // MIN_EXPORT_MESSAGES after filtering are incomplete runs.
              const exported = [];
              for (const info of infos.slice(0, limit)) {
                try {
                  const handle = await session.open(info.id);
                  const messages = (handle.messages() ?? [])
                    .filter((message) => message?.role === "user" || message?.role === "assistant")
                    .filter((message) => typeof message.content === "string")
                    .filter((message) => !(message.role === "user" && (message.content.startsWith("[steering]") || message.content.startsWith("[system]"))))
                    .map((message) => ({ role: message.role, content: message.content.slice(0, MAX_CONTENT_CHARS) }));
                  if (messages.length < MIN_EXPORT_MESSAGES) continue;
                  exported.push({ sessionId: info.id, exportedAt: new Date().toISOString(), messages });
                } catch {
                  // unreadable session: skip it
                }
              }
              const sftFile = join(store.dir, "sft.jsonl");
              await mkdir(store.dir, { recursive: true });
              const body = exported.map((record) => JSON.stringify(record)).join("\n");
              await writeFile(sftFile, body ? `${body}\n` : "", "utf-8");
              return exported.length === 0
                ? `exported 0 sessions -> ${sftFile} (no session had >= ${MIN_EXPORT_MESSAGES} clean messages)`
                : `exported ${exported.length} session(s) -> ${sftFile}`;
            }

            if (arg === "learn") {
              // triggers write-back: router-memory.json already records which
              // fingerprints recalled which plugin and whether the recall was
              // actually used. Confirmed tokens (net score >= 1) become L0
              // manifest keywords so the plugin recalls deterministically.
              const memoryFile = join(ctx.cwd, ".flavorlite", "router-memory.json");
              let memory;
              try {
                memory = JSON.parse(await readFile(memoryFile, "utf-8"));
              } catch {
                memory = undefined;
              }
              if (!Array.isArray(memory) || memory.length === 0) {
                return "no router feedback memory found (.flavorlite/router-memory.json)";
              }
              const scores = new Map(); // plugin name -> Map<token, {used, unused}>
              for (const entry of memory) {
                if (!entry || typeof entry.plugin !== "string" || !Array.isArray(entry.fp)) continue;
                let tokens = scores.get(entry.plugin);
                if (!tokens) {
                  tokens = new Map();
                  scores.set(entry.plugin, tokens);
                }
                for (const token of new Set(entry.fp)) {
                  if (typeof token !== "string" || token.length < 2) continue;
                  const score = tokens.get(token) ?? { used: 0, unused: 0 };
                  if (entry.used === true) score.used += 1;
                  else score.unused += 1;
                  tokens.set(token, score);
                }
              }
              const auditFile = join(store.dir, "learned-triggers.json");
              let audit = {};
              try {
                audit = JSON.parse(await readFile(auditFile, "utf-8"));
              } catch {
                audit = {};
              }
              const lines = [];
              for (const status of loader.list()) {
                const tokens = scores.get(status.name);
                if (!tokens) continue;
                const candidates = [...tokens.entries()]
                  .map(([token, counts]) => ({
                    token,
                    ...counts,
                    support: counts.used + counts.unused,
                    precision: counts.used / Math.max(1, counts.used + counts.unused),
                  }))
                  .filter((candidate) => candidate.support >= learnMinSupport && candidate.precision >= learnMinPrecision)
                  .sort((a, b) => b.precision - a.precision || b.support - a.support || a.token.localeCompare(b.token));
                const manifestFile = join(status.dir, "flavor-plugin.json");
                try {
                  const manifest = JSON.parse(await readFile(manifestFile, "utf-8"));
                  const existing = Array.isArray(manifest.triggers?.keywords) ? manifest.triggers.keywords : [];
                  const previouslyLearned = new Set(Array.isArray(audit[status.name]) ? audit[status.name] : []);
                  const desired = candidates.map((candidate) => candidate.token);
                  const desiredLower = new Set(desired.map((token) => token.toLocaleLowerCase()));
                  const authored = existing.filter((keyword) => !previouslyLearned.has(String(keyword)));
                  const room = Math.max(0, MAX_TRIGGER_KEYWORDS - authored.length);
                  const learned = desired
                    .filter((token) => !authored.some((keyword) => String(keyword).toLocaleLowerCase() === token.toLocaleLowerCase()))
                    .slice(0, room);
                  const next = [...authored, ...learned];
                  const additions = learned.filter((token) => !existing.some((keyword) => String(keyword).toLocaleLowerCase() === token.toLocaleLowerCase()));
                  const removals = existing.filter((keyword) => previouslyLearned.has(String(keyword)) && !desiredLower.has(String(keyword).toLocaleLowerCase()));
                  if (JSON.stringify(next) === JSON.stringify(existing)) continue;
                  manifest.triggers = {
                    ...(manifest.triggers ?? {}),
                    keywords: next,
                  };
                  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
                  audit[status.name] = learned;
                  lines.push(`learned triggers: ${status.name} +[${additions.join(", ")}] -[${removals.join(", ")}]`);
                } catch {
                  // manifest missing or unwritable: skip this plugin (fail-safe)
                }
              }
              await mkdir(store.dir, { recursive: true });
              await writeFile(auditFile, `${JSON.stringify(audit, null, 2)}\n`, "utf-8");
              return lines.length > 0
                ? lines.join("\n")
                : `no new triggers learned (need support >= ${learnMinSupport} and precision >= ${learnMinPrecision})`;
            }

            if (arg === "test" || arg.startsWith("test ")) {
              const suggestionId = arg.startsWith("test ") ? arg.slice(5).trim() : "";
              const episode = suggestionId
                ? (await store.episodes(200)).find((entry) => entry.suggestionId === suggestionId)
                : undefined;
              if (suggestionId && !episode) return `no evolution episode for suggestion "${suggestionId}"`;
              if (episode && (!episode.verificationCommand || episode.baseline?.ok !== false)) {
                return `refusing: episode ${episode.id} has no captured red baseline; run /evolve baseline ${suggestionId} <focused-command> before implementation`;
              }
              const commandsToRun = [
                ...(episode?.verificationCommand ? [episode.verificationCommand] : []),
                ...verificationCommands,
              ].filter((command, index, all) => all.indexOf(command) === index);
              const reports = [];
              for (const command of commandsToRun) {
                const result = await runCommand(command, ctx.cwd, testTimeoutMs);
                reports.push({ command, ok: result.ok, code: result.code, stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) });
                if (!result.ok) {
                  if (episode?.ruleId) await store.updateRule(episode.ruleId, { active: false });
                  if (episode?.pluginName) await loader.eject(episode.pluginName).catch(() => {});
                  if (episode) {
                    await store.updateEpisode(episode.id, "rejected", {
                      verification: reports,
                      rejectedAt: new Date().toISOString(),
                      reason: `verification failed: ${command}`,
                    });
                  }
                  return `verification FAILED: ${command} (exit ${result.code})${result.stderr ? `\n${result.stderr.slice(-4000)}` : ""}`;
                }
              }
              if (episode) await store.updateEpisode(episode.id, "verified", { verification: reports, verifiedAt: new Date().toISOString() });
              return `verification passed (${commandsToRun.length} command(s))${episode ? `; episode ${episode.id} is verified and ready for /evolve done ${suggestionId}` : ""}`;
            }

            if (arg === "episodes") {
              const episodes = await store.episodes(20);
              return episodes.length === 0
                ? "no evolution episodes yet"
                : episodes.map((episode) => `[${episode.id}] ${episode.suggestionId} ${episode.status}${episode.pluginName ? ` plugin=${episode.pluginName}` : ""}`).join("\n");
            }

            if (arg.startsWith("baseline ")) {
              const rest = arg.slice(9).trim();
              const splitAt = rest.indexOf(" ");
              if (splitAt <= 0) return "usage: /evolve baseline <suggestionId> <focused-command>";
              const suggestionId = rest.slice(0, splitAt);
              const command = rest.slice(splitAt + 1).trim();
              const episode = (await store.episodes(200)).find((entry) => entry.suggestionId === suggestionId);
              if (!episode) return `no implemented episode for suggestion "${suggestionId}"`;
              if (episode.status !== "implemented") return `refusing: episode ${episode.id} is already ${episode.status}`;
              const result = await runCommand(command, ctx.cwd, testTimeoutMs);
              if (result.ok) return "refusing: focused command already passes; it does not reproduce the pre-change failure";
              await store.updateEpisode(episode.id, "implemented", {
                verificationCommand: command,
                baseline: { ok: false, code: result.code, stderr: result.stderr.slice(-2000) },
              });
              return `captured red baseline for episode ${episode.id}; implement the change, then /evolve test ${suggestionId}`;
            }

            if (arg === "clear") {
              await store.clearSignals();
              return "cleared signals, patterns and done markers";
            }

            if (arg.startsWith("verify ")) {
              const name = arg.slice(7).trim();
              if (!name) return "usage: /evolve verify <plugin>";
              const report = await loader.verify(name);
              if (!report.ok) return `verify FAILED: ${name}\n  ${report.error ?? "unknown error"}`;
              const episode = (await store.episodes(200)).find((entry) => entry.pluginName === name);
              if (episode) await store.updateEpisode(episode.id, episode.status, { smokeVerified: true, smokeVerifiedAt: new Date().toISOString() });
              return [
                `verify OK: ${name} (sandbox dry-run, host untouched)`,
                `  provides: ${report.provided.join(", ") || "-"}`,
                `  tools: ${report.tools.join(", ") || "-"}`,
                `  commands: ${report.commands.join(", ") || "-"}`,
              ].join("\n");
            }

            if (arg.startsWith("revert ")) {
              const name = arg.slice(7).trim();
              if (!name) return "usage: /evolve revert <plugin>";
              try {
                const message = await loader.revert(name);
                const episode = (await store.episodes(200)).find((entry) => entry.pluginName === name);
                if (episode) await store.updateEpisode(episode.id, "rolled_back", { rolledBackAt: new Date().toISOString() });
                return message;
              } catch (error) {
                return `error: ${error instanceof Error ? error.message : String(error)}`;
              }
            }

            if (arg.startsWith("done ")) {
              const id = arg.slice(5).trim();
              if (!id) return "usage: /evolve done <suggestionId>";
              const episode = (await store.episodes(200)).find((entry) => entry.suggestionId === id);
              if (!episode) return `refusing: no implemented episode for ${id}; use /evolve improve or evolve_improve first`;
              if (episode.status !== "verified") return `refusing: episode ${episode.id} is ${episode.status}; run /evolve test ${id} first`;
              await store.updateEpisode(episode.id, "canary", { canaryCount: 0, canaryStartedAt: new Date().toISOString() });
              return `episode ${episode.id} entered canary; it will be accepted after ${canaryRuns} clean runs that exercise ${episode.source?.tool ?? "the affected capability"}`;
            }

            if (arg.startsWith("dismiss ")) {
              const id = arg.slice(8).trim();
              if (!id) return "usage: /evolve dismiss <suggestionId>";
              const episode = (await store.episodes(200)).find((entry) => entry.suggestionId === id);
              if (episode?.ruleId) await store.updateRule(episode.ruleId, { active: false });
              if (episode?.pluginName) await loader.eject(episode.pluginName).catch(() => {});
              if (episode) {
                await store.updateEpisode(episode.id, "rejected", {
                  rejectedAt: new Date().toISOString(),
                  reason: "dismissed by operator",
                });
              }
              await store.markSuggestionDone(id);
              return `dismissed ${id} without claiming an improvement`;
            }

            if (arg.startsWith("improve ")) {
              const suggestionId = arg.slice(8).trim();
              const doneIds = new Set(await store.readDoneIds());
              const activeIds = new Set(await store.activeSuggestionIds());
              const suggestions = [
                ...(await store.openSuggestions({ threshold: minRepeats, limit: 100 })),
                ...(await store.openPatternSuggestions({ threshold: patternThreshold, limit: 100 })),
                ...(await readAnalyzedErrors(ctx.cwd, emConfidence)).filter((entry) => !doneIds.has(entry.id) && !activeIds.has(entry.id)),
              ];
              const suggestion = suggestions.find((s) => s.id === suggestionId);
              if (!suggestion) {
                return `No open suggestion with id "${suggestionId}". Use /evolve suggest to list them.`;
              }
              let dir;
              try {
                const base = suggestion.tool ?? suggestion.sequence?.join("-") ?? "fix";
                const pluginName = `${sanitizePluginName(base)}-${suggestion.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
                dir = await loader.scaffold(pluginName);
              } catch (error) {
                return `Failed to scaffold plugin: ${error instanceof Error ? error.message : String(error)}`;
              }
              try {
                const manifestFile = join(dir, "flavor-plugin.json");
                const manifest = JSON.parse(await readFile(manifestFile, "utf-8"));
                manifest.origin = "generated";
                manifest.generatedFrom = suggestion.id;
                await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
              } catch {
                // manifest missing: leave provenance to the caller
              }
              const pluginName = `${sanitizePluginName(suggestion.tool ?? suggestion.sequence?.join("-") ?? "fix")}-${suggestion.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
              const episode = await store.beginEpisode({ suggestionId: suggestion.id, kind: "plugin", implementation: "operator scaffold", pluginName, source: suggestion });
              return [
                `suggestion ${suggestion.id}: ${suggestion.tool} x${suggestion.count} — ${suggestion.error}`,
                `scaffolded plugin at ${dir}`,
                `episode ${episode.id} is implemented, not done; edit index.js, then run /evolve verify ${pluginName}, /plugin reload ${pluginName}, /evolve test ${suggestion.id}, and /evolve done ${suggestion.id}`,
                `note: generated plugins are read-only by default — if the fix needs file writes or shell commands, add "capabilities": ["files"] or ["shell"] to flavor-plugin.json`,
              ].join("\n");
            }

            return [
              "usage: /evolve <signals|suggest|episodes|improve <id>|baseline <id> <command>|verify <plugin>|revert <plugin>|test [id]|clear|done <id>|dismiss <id>|export [limit]|learn>",
              "  signals   list recent failing tool results",
              "  suggest   aggregate repeated failures, recurring success trigrams and analyzed error-monitor records into suggestions",
              "  improve   scaffold a plugin dir for one suggestion",
              "  verify    sandbox dry-run a plugin before activating it",
              "  revert    restore the last good snapshot of a plugin",
              "  test      run focused regression plus test/typecheck/build; marks an episode verified",
              "  clear     reset signals, patterns and done markers",
              "  export    write clean session trajectories to .flavorlite/evolve/sft.jsonl",
              "  learn     write confirmed router-recall tokens back into plugin manifests",
            ].join("\n");
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "evolve.install");
  },
};
