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
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: `${stderr}\n[killed: exceeded ${timeoutMs}ms]`, code: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`, code: "spawn" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export default {
  name: "evolve",
  version: "0.1.0",
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

      const store = new EvolveStore({ cwd: ctx.cwd });
      const disposers = [];
      // Success-call names of the current run (values never recorded);
      // flushed into trigram patterns on loop/after-run.
      const recentCalls = [];

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
              await store.recordSignal({
                tool: event.toolCall.name,
                args: event.args ?? event.toolCall.args,
                error: event.result.content,
              });
            } else {
              recentCalls.push(event.toolCall.name);
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
            const seen = new Set();
            for (let i = 0; i + 3 <= recentCalls.length; i += 1) {
              const trigram = recentCalls.slice(i, i + 3);
              const key = trigram.join("->");
              if (seen.has(key)) continue;
              seen.add(key);
              await store.recordPattern({ sequence: trigram });
            }
            recentCalls.length = 0;

            const current = await store.signals();
            const failedTools = current
              .filter((signal) => (signal.count ?? 1) >= minRepeats)
              .map((signal) => signal.tool);
            const totalFailures = current.reduce((sum, signal) => sum + (signal.count ?? 1), 0);
            const [previous] = await store.reflections(1);
            await store.appendReflection({
              iterations: event.iterations ?? 0,
              reason: event.reason ?? "finished",
              toolCalls: event.toolCalls ?? 0,
              toolErrors: event.toolErrors ?? 0,
              steers: event.steers ?? 0,
              totalFailures,
              signalDelta: previous ? totalFailures - (previous.totalFailures ?? 0) : 0,
              failedTools,
            });
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
          category: "write",
          inputSchema: {
            type: "object",
            properties: {
              suggestionId: { type: "string", description: "Signal id from the evolve suggestions" },
              implementation: { type: "string", description: "Concise description of the fix to implement" },
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
            const doneIds = new Set(await store.readDoneIds());
            const analyzed = (await readAnalyzedErrors(ctx.cwd, emConfidence)).filter((entry) => !doneIds.has(entry.id));
            const suggestions = [
              ...(await store.openSuggestions({ threshold: minRepeats, limit: 100 })),
              ...(await store.openPatternSuggestions({ threshold: patternThreshold, limit: 100 })),
              ...analyzed,
            ];
            const suggestion = suggestions.find((s) => s.id === suggestionId);
            if (!suggestion) {
              return { content: `No open suggestion with id "${suggestionId}".`, isError: true };
            }

            if (kind === "prompt_rule") {
              await store.appendRule(implementation);
              await store.markSuggestionDone(suggestion.id);
              return {
                content: [
                  `Distilled suggestion [${suggestion.id}] into a prompt rule and marked it done.`,
                  `Rule: ${implementation}`,
                  `It is injected into the system prompt from .flavorlite/evolve/rules.md on every run.`,
                ].join("\n"),
              };
            }

            const loader = ctx.get("pluginsLoader");
            const name = sanitizePluginName(suggestion.tool ?? suggestion.sequence?.join("-") ?? "fix");
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
              manifest.generatedFrom = new Date().toISOString();
              await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
            } catch {
              // manifest missing: leave provenance to the caller
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
                `5. Run /evolve done ${suggestion.id} to close the suggestion. If anything breaks, /evolve revert ${name} restores the last good version.`,
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
              const analyzed = (await readAnalyzedErrors(ctx.cwd, emConfidence)).filter((entry) => !doneIds.has(entry.id));
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
              const scores = new Map(); // plugin name -> Map<token, net score>
              for (const entry of memory) {
                if (!entry || typeof entry.plugin !== "string" || !Array.isArray(entry.fp)) continue;
                let tokens = scores.get(entry.plugin);
                if (!tokens) {
                  tokens = new Map();
                  scores.set(entry.plugin, tokens);
                }
                for (const token of new Set(entry.fp)) {
                  if (typeof token !== "string" || token.length < 2) continue;
                  tokens.set(token, (tokens.get(token) ?? 0) + (entry.used === true ? 1 : -1));
                }
              }
              const lines = [];
              for (const status of loader.list()) {
                const tokens = scores.get(status.name);
                if (!tokens) continue;
                const candidates = [...tokens.entries()]
                  .filter(([, score]) => score >= 1)
                  .map(([token]) => token)
                  .sort();
                if (candidates.length === 0) continue;
                const manifestFile = join(status.dir, "flavor-plugin.json");
                try {
                  const manifest = JSON.parse(await readFile(manifestFile, "utf-8"));
                  const existing = Array.isArray(manifest.triggers?.keywords) ? manifest.triggers.keywords : [];
                  const seen = new Set(existing.map((keyword) => String(keyword).toLowerCase()));
                  const additions = candidates.filter((token) => !seen.has(token.toLowerCase()));
                  if (additions.length === 0) continue;
                  manifest.triggers = {
                    ...(manifest.triggers ?? {}),
                    keywords: [...existing, ...additions].slice(0, MAX_TRIGGER_KEYWORDS),
                  };
                  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
                  lines.push(`learned triggers: ${status.name} +[${additions.join(", ")}]`);
                } catch {
                  // manifest missing or unwritable: skip this plugin (fail-safe)
                }
              }
              return lines.length > 0
                ? lines.join("\n")
                : "no new triggers learned (nothing scored >= 1, or all candidates already present)";
            }

            if (arg === "test") {
              const result = await runCommand(testCommand, ctx.cwd, testTimeoutMs);
              return result.ok
                ? `tests passed (exit 0)${result.stdout ? `\n${result.stdout.slice(-4000)}` : ""}`
                : `tests FAILED (exit ${result.code})${result.stderr ? `\n${result.stderr.slice(-4000)}` : ""}`;
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
                return await loader.revert(name);
              } catch (error) {
                return `error: ${error instanceof Error ? error.message : String(error)}`;
              }
            }

            if (arg.startsWith("done ")) {
              const id = arg.slice(5).trim();
              if (!id) return "usage: /evolve done <suggestionId>";
              await store.markSuggestionDone(id);
              return `marked ${id} done`;
            }

            if (arg.startsWith("improve ")) {
              const suggestionId = arg.slice(8).trim();
              const suggestions = await store.openSuggestions({ threshold: minRepeats, limit: 100 });
              const suggestion = suggestions.find((s) => s.id === suggestionId);
              if (!suggestion) {
                return `No open suggestion with id "${suggestionId}". Use /evolve suggest to list them.`;
              }
              let dir;
              try {
                dir = await loader.scaffold(sanitizePluginName(suggestion.tool));
              } catch (error) {
                return `Failed to scaffold plugin: ${error instanceof Error ? error.message : String(error)}`;
              }
              try {
                const manifestFile = join(dir, "flavor-plugin.json");
                const manifest = JSON.parse(await readFile(manifestFile, "utf-8"));
                manifest.origin = "generated";
                manifest.generatedFrom = new Date().toISOString();
                await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
              } catch {
                // manifest missing: leave provenance to the caller
              }
              const pluginName = sanitizePluginName(suggestion.tool);
              await store.markSuggestionDone(suggestion.id);
              return [
                `suggestion ${suggestion.id}: ${suggestion.tool} x${suggestion.count} — ${suggestion.error}`,
                `scaffolded plugin at ${dir}`,
                `edit index.js to implement the fix, then run /evolve verify ${pluginName}, /plugin reload ${pluginName} and /evolve test`,
                `note: generated plugins are read-only by default — if the fix needs file writes or shell commands, add "capabilities": ["files"] or ["shell"] to flavor-plugin.json`,
              ].join("\n");
            }

            return [
              "usage: /evolve <signals|suggest|improve <id>|verify <plugin>|revert <plugin>|test|clear|done <id>|export [limit]|learn>",
              "  signals   list recent failing tool results",
              "  suggest   aggregate repeated failures, recurring success trigrams and analyzed error-monitor records into suggestions",
              "  improve   scaffold a plugin dir for one suggestion",
              "  verify    sandbox dry-run a plugin before activating it",
              "  revert    restore the last good snapshot of a plugin",
              "  test      run the test suite (npm test)",
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
