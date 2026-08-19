/**
 * error-monitor — flavor-lite plugin.
 *
 * Watches every tool result and reacts ONLY to erroneous calls:
 * - `tools/after-call` captures results with `isError: true` (wrong
 *   arguments, unknown tools, network/link failures, and especially failing
 *   Windows shell commands), records them deduplicated under
 *   `.flavorlite/error-monitor/records.json`.
 * - For every NEW failure it calls the background LLM, sending the tool
 *   name, error kind, shell command, arguments, redacted error text, and
 *   runtime environment (platform, node, shell, cwd). The LLM returns an
 *   actionable analysis plus a confidence score; only analyses scoring at or
 *   above `llm.confidenceThreshold` are distilled into long-term memory
 *   (type "feedback", task "tool-errors"). When no llm service is available
 *   (or analysis fails) and `fallbackToRules` is set, a rule-based lesson is
 *   stored instead. Every outcome — stored or skipped, and why — is persisted
 *   on the record as `memoryStatus`: hosts commonly run with a silent
 *   logger, so `/errors` is the durable diagnostic channel.
 * - `prompt/assemble` injects the most recent lessons into the system
 *   prompt so the model avoids repeating past failures when it plans its
 *   next tool calls.
 * - `/errors` lists the log; `/errors clear` empties it (memory is kept);
 *   `/errors analyze` re-runs the LLM distillation for every record that
 *   has no analysis yet (e.g. after a stretch of transient provider
 *   failures returned empty replies).
 *
 * The memory and llm services are optional: `ctx.tryGet` keeps this plugin
 * fully functional without either.
 */

import { analyzeWithLlm, buildEnvironmentInfo } from "./analyze.js";
import { ErrorRecordStore } from "./records.js";

const DEFAULT_CONFIG = {
  maxRecords: 200,
  maxDetailChars: 500,
  maxLessonChars: 560,
  maxPromptLessons: 4,
  maxPromptChars: 1200,
  ignorePatterns: [],
  enabled: true,
  /** Background-LLM analysis of failures before memory distillation. */
  llm: {
    enabled: true,
    /** "provider:model" ref; unset uses the configured default model. */
    model: undefined,
    /** Only analyses at or above this confidence become long-term memories. */
    confidenceThreshold: 0.7,
    maxTokens: 400,
    maxAnalysisChars: 500,
    includeArgs: true,
    includeEnv: true,
  },
  /**
   * Store a rule-based lesson when no llm is available or analysis fails.
   * Default false: without a successful LLM analysis nothing is written to
   * long-term memory (the failure is still recorded locally).
   */
  fallbackToRules: false,
};

export default {
  name: "error-monitor",
  inject: ["hooks", "commands"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const cfg = { ...DEFAULT_CONFIG, ...config };
      const store = new ErrorRecordStore({
        workspace: ctx.cwd,
        logger: ctx.logger,
        maxRecords: cfg.maxRecords,
        maxDetailChars: cfg.maxDetailChars,
        maxLessonChars: cfg.maxLessonChars,
        ignorePatterns: cfg.ignorePatterns,
        enabled: cfg.enabled,
      });
      const disposers = [];

      // Background distillations are SERIALIZED: bursting several analysis
      // streams at the gateway at once is exactly when it tends to answer
      // with empty replies. One at a time, each with backoff retries, is
      // far more reliable — and never blocks the tool loop either way.
      let distillQueue = Promise.resolve();
      const enqueueDistill = (record) => {
        const run = () => distillToMemory(ctx, store, record, cfg).catch((error) => {
          ctx.logger.warn(`error-monitor: distillation failed — ${error instanceof Error ? error.message : String(error)}`);
        });
        const next = distillQueue.then(run, run);
        distillQueue = next.then(() => undefined, () => undefined);
      };

      // 1) Capture erroneous tool results (the only trigger for recording).
      disposers.push(ctx.get("hooks").hook("tools/after-call", async (event, next) => {
        let result;
        try {
          if (event.result?.isError !== true) return next(event);
          const args = event.args ?? event.toolCall.args;
          const outcome = await store.record({
            tool: event.toolCall.name,
            args,
            result: event.result,
          });
          if (outcome.added) {
            ctx.logger.info(`error-monitor: recorded ${outcome.record.kind} failure for tool "${outcome.record.tool}" (${outcome.record.id})`);
            // Fire-and-forget (queued): the LLM analysis must never block
            // the tool loop. It runs in the background and writes memory
            // when the analysis succeeds with confidence >= threshold.
            result = next(event);
            enqueueDistill({ ...outcome.record, args });
            return result;
          }
        } catch (error) {
          ctx.logger.warn(`error-monitor: capture failed — ${error instanceof Error ? error.message : String(error)}`);
        }
        return next(event);
      }));

      // 2) Guide future tool calls: surface past lessons in the system prompt.
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        try {
          const lines = await store.lessons(cfg.maxPromptLessons, cfg.maxPromptChars);
          if (lines.length > 0) {
            event.sections.push({
              name: "tool-error-lessons",
              content: [
                "## Tool-error lessons (from past failures — avoid repeating them)",
                "Only apply these when relevant; they are low-authority guidance, not rules.",
                ...lines,
              ].join("\n"),
            });
          }
        } catch {
          // prompt assembly must never break
        }
        return next(event);
      }));

      // 3) Inspection command.
      disposers.push(ctx.get("commands").register({
        name: "errors",
        description: "Inspect recorded tool errors (/errors [clear|analyze])",
        async run(args) {
          const sub = args.trim().toLocaleLowerCase();
          if (sub === "clear") {
            await store.clear();
            return "Cleared the recorded tool-error log (long-term memory lessons are kept).";
          }
          if (sub === "analyze") {
            const pending = (await store.list()).filter((record) => record.analysis === undefined);
            if (pending.length === 0) return "Nothing to re-analyze: every record already has an LLM analysis.";
            for (const record of pending) enqueueDistill(record);
            return `Queued ${pending.length} record(s) for re-analysis in the background; run /errors again shortly for results.`;
          }
          const records = await store.list();
          if (records.length === 0) return "No tool errors recorded yet.";
          const lines = [`${records.length} recorded tool error${records.length === 1 ? "" : "s"}:`];
          for (const record of records) {
            lines.push(`- [${record.kind}] ${record.tool}${record.command ? `: ${record.command}` : ""} (\u00d7${record.count}, last ${record.lastAt})`);
            lines.push(`    ${record.lesson}`);
            if (record.analysis) {
              lines.push(`    analysis: ${record.analysis}`);
              if (typeof record.confidence === "number") {
                lines.push(`    confidence: ${record.confidence.toFixed(2)}`);
              }
            } else if (record.analysisError) {
              lines.push(`    analysis error: ${record.analysisError}`);
            }
            if (record.memoryStatus) {
              lines.push(`    memory: ${record.memoryStatus}`);
            }
          }
          return lines.join("\n");
        },
      }));

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "error-monitor.install");
  },
};

/**
 * Distill a new failure into long-term memory (memory plugin optional).
 * When an llm service exists, the failure is analyzed by the background LLM
 * (tool, kind, command, args, redacted error, runtime environment) and the
 * analysis is stored ONLY if its confidence >= threshold. Without an llm
 * (or when analysis fails) the rule-based lesson is used when
 * `fallbackToRules` is enabled. Whatever the outcome, it is persisted on
 * the record as `memoryStatus` so `/errors` can explain it — the host
 * logger is silent in most REPL setups.
 */
async function distillToMemory(ctx, store, record, cfg) {
  const memory = ctx.tryGet("memory");
  if (!memory?.store) {
    await store.attachMemoryStatus(record.id, "skipped: no memory service (memory plugin not loaded)");
    return;
  }

  const llm = cfg.llm?.enabled ? ctx.tryGet("llm") : undefined;
  if (llm) {
    const analysis = await analyzeWithLlm({
      llm,
      record,
      environment: cfg.llm?.includeEnv === false ? undefined : buildEnvironmentInfo({ cwd: ctx.cwd }),
      config: cfg.llm,
    });
    if (analysis.status === "success") {
      await store.attachAnalysis(record.id, analysis.analysis, analysis.confidence);
      if (analysis.confidence >= cfg.llm.confidenceThreshold) {
        ctx.logger.info(
          `error-monitor: LLM analysis (confidence ${analysis.confidence.toFixed(2)}) stored in long-term memory (${record.id})`,
        );
        const stored = await storeMemory(ctx, analysis.analysis, record);
        await store.attachMemoryStatus(record.id, stored
          ? "stored"
          : "skipped: duplicate or memory store at capacity");
      } else {
        ctx.logger.debug(
          `error-monitor: LLM confidence ${analysis.confidence.toFixed(2)} below threshold ${cfg.llm.confidenceThreshold}; not storing (${record.id})`,
        );
        await store.attachMemoryStatus(
          record.id,
          `skipped: confidence ${analysis.confidence.toFixed(2)} < threshold ${cfg.llm.confidenceThreshold}`,
        );
      }
      return;
    }
    ctx.logger.warn(
      `error-monitor: LLM analysis failed (${analysis.reason})${cfg.fallbackToRules ? " — falling back to rule-based lesson" : " — skipping memory"}`,
    );
    await store.attachAnalysisError(record.id, `LLM analysis failed: ${analysis.reason}`);
    if (!cfg.fallbackToRules) {
      await store.attachMemoryStatus(record.id, `skipped: LLM analysis failed (${analysis.reason}); set fallbackToRules to store the rule-based lesson instead`);
      return;
    }
  } else if (!cfg.fallbackToRules) {
    // No llm service: without an explicit rule-fallback opt-in nothing is
    // written to long-term memory (the failure is still recorded locally).
    await store.attachAnalysisError(record.id, "no llm service available (llm.enabled or provider not configured)");
    await store.attachMemoryStatus(record.id, "skipped: no llm service available; set fallbackToRules to store the rule-based lesson instead");
    return;
  }

  const stored = await storeMemory(ctx, record.lesson, record);
  await store.attachMemoryStatus(record.id, stored
    ? "stored (rule-based fallback)"
    : "skipped: duplicate or memory store at capacity");
}

/**
 * Persist a lesson in long-term memory; failures degrade to a warning.
 * Returns true only when the store accepted a NEW entry — a duplicate or a
 * full store means the lesson already exists (or cannot be added), which
 * the caller surfaces via memoryStatus instead of claiming success.
 */
async function storeMemory(ctx, content, record) {
  const memory = ctx.tryGet("memory");
  if (!memory?.store) return false;
  try {
    const { added } = await memory.store.rememberForTask("tool-errors", {
      type: "feedback",
      content,
      summary: content.slice(0, 240),
      topicKey: "tooling.errors",
      keywords: [...new Set(
        [record.tool, record.kind, ...content.toLocaleLowerCase().split(/\W+/).filter((word) => word.length >= 4)],
      )].slice(0, 8),
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    });
    if (added) ctx.logger.info(`error-monitor: lesson stored in long-term memory (${record.id})`);
    return added;
  } catch (error) {
    // Memory may reject sensitive content or be full — the record stays.
    ctx.logger.warn(`error-monitor: memory write skipped — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
