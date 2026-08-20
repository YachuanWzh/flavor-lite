// hallucination-detector — full-lifecycle hallucination audit for agent runs.
//
// Treats the agent as a perceive → plan → act → reflect closed loop and
// attributes every signal to a lifecycle stage instead of judging only the
// final answer:
//
//   loop/after-run (gate: reason=finished, toolCalls >= minToolCalls)
//   -> read the latest session transcript via the session service
//   -> heuristic audit (pure analyzer.js rules):
//      * tool-execution: repeat-window hash loops (same tool + sorted args
//        hash appearing >= threshold times inside a sliding window),
//        flip-flop edits, ignored failures, misread results
//      * reasoning: self-contradicting statements
//      * memory-state: compaction decay, steering drift
//      * process: redundant exploration, dead-end check chains
//      * output-grounding: files/commands claimed without evidence
//   -> optional LLM-as-a-Judge (input-planning stage): user request vs
//      actual completion, strict-JSON reply, merged as attributed findings
//   -> append the report to .flavorlite/hallucination/reports.jsonl and
//      (when mounted) mirror it into the telemetry feed
//
// Audits are fire-and-forget and never block the loop; every failure only
// warns. `/hallucination` shows, re-runs and clears reports.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  analyzeRun,
  buildJudgePrompt,
  extractTrace,
  formatReport,
  parseJudgeReply,
  DEFAULT_REPEAT,
} from "./analyzer.js";

const DEFAULT_CONFIG = {
  enabled: true,
  /** Run the audit automatically after every finished loop run. */
  autoAudit: true,
  /** Skip audit for runs with fewer tool calls (pure chat stays cheap). */
  minToolCalls: 1,
  /** Repeat-window detection: hash must appear >= threshold times in windowSize calls. */
  repeat: { windowSize: 20, threshold: 10 },
  judge: {
    /** LLM-as-a-Judge for the input-planning stage (needs an llm service). */
    enabled: true,
    /** "provider:model" ref; unset uses the configured default model. */
    model: undefined,
    maxTokens: 800,
    timeoutMs: 30000,
  },
  /** Rolling cap of stored reports. */
  maxReports: 200,
};

/** Collect a full text response from an async-iterable LLM stream. */
async function collectLlmText(llm, options) {
  let text = "";
  const stream = llm.stream(options);
  for await (const event of stream) {
    if (event.type === "text_delta") text += event.text;
  }
  return text.trim();
}

/** Append-only JSONL report store with a rolling cap (single host assumed). */
class ReportStore {
  constructor(filePath, maxReports) {
    this.filePath = filePath;
    this.maxReports = maxReports;
    this.queue = Promise.resolve();
  }

  append(report) {
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(report)}\n`, "utf-8");
        await this.trim();
      })
      .catch(() => {});
    return this.queue;
  }

  async list() {
    await this.queue;
    let raw;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const reports = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        reports.push(JSON.parse(line));
      } catch {
        /* torn line never poisons the feed */
      }
    }
    return reports;
  }

  async latest() {
    const reports = await this.list();
    return reports[reports.length - 1];
  }

  async clear() {
    await this.queue;
    this.queue = this.queue
      .then(() => writeFile(this.filePath, "", "utf-8"))
      .catch(() => {});
    await this.queue;
  }

  async trim() {
    const raw = await readFile(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    if (lines.length <= this.maxReports) return;
    await writeFile(this.filePath, `${lines.slice(-this.maxReports).join("\n")}\n`, "utf-8");
  }
}

export default {
  name: "hallucination-detector",
  inject: ["hooks", "commands"],
  provides: ["hallucination"],

  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const cfg = {
        ...DEFAULT_CONFIG,
        ...config,
        repeat: { ...DEFAULT_REPEAT, ...(config.repeat ?? {}) },
        judge: { ...DEFAULT_CONFIG.judge, ...(config.judge ?? {}) },
      };
      if (cfg.enabled === false) return;

      const store = new ReportStore(
        join(ctx.cwd, ".flavorlite", "hallucination", "reports.jsonl"),
        cfg.maxReports,
      );
      const disposers = [];
      const pending = new Set();
      const track = (promise) => {
        pending.add(promise);
        promise.finally(() => pending.delete(promise));
      };

      /** Run one audit over the latest (or given) session; returns the report. */
      async function audit(sessionId) {
        const session = ctx.tryGet("session");
        if (!session) return undefined;
        const id = sessionId ?? (await session.latest());
        if (!id) return undefined;
        const handle = await session.open(id);
        const messages = handle.messages();
        if (!messages || messages.length === 0) return undefined;

        const trace = extractTrace(messages);
        let judge;
        const llm = cfg.judge.enabled ? ctx.tryGet("llm") : undefined;
        if (llm && trace.finalAnswer.trim()) {
          try {
            const raw = await collectLlmText(llm, {
              ...(cfg.judge.model ? { model: cfg.judge.model } : {}),
              systemPrompt: "You are a strict audit judge for a coding agent. Reply with strict JSON only.",
              messages: [{ role: "user", content: buildJudgePrompt(trace) }],
              maxTokens: cfg.judge.maxTokens,
              thinking: "disabled",
              signal: AbortSignal.timeout(cfg.judge.timeoutMs),
            });
            judge = parseJudgeReply(raw);
          } catch (error) {
            ctx.logger.warn(
              `hallucination-detector: judge failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const report = { sessionId: id, ...analyzeRun(trace, { repeat: cfg.repeat, judge }) };
        await store.append(report);
        const telemetry = ctx.tryGet("telemetry");
        if (telemetry) {
          telemetry.record({
            type: "hallucination.audit",
            sessionId: id,
            score: report.score,
            verdict: report.verdict,
            findings: report.findings.length,
          });
        }
        return report;
      }

      // Service for tests and other plugins.
      disposers.push(
        ctx.provide("hallucination", {
          audit,
          latest: () => store.latest(),
          list: () => store.list(),
          clear: () => store.clear(),
          idle: async () => {
            while (pending.size > 0) await Promise.allSettled([...pending]);
          },
        }),
      );

      // 1) Automatic audit after every finished run (fire-and-forget).
      if (cfg.autoAudit) {
        disposers.push(
          ctx.get("hooks").hook("loop/after-run", async (event, next) => {
            try {
              if (event.reason === "finished" && (event.toolCalls ?? 0) >= cfg.minToolCalls) {
                track(
                  audit().catch((error) => {
                    ctx.logger.warn(
                      `hallucination-detector: audit failed — ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }),
                );
              }
            } catch (error) {
              ctx.logger.warn(
                `hallucination-detector: after-run gate failed — ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return next(event);
          }),
        );
      }

      // 2) Inspection command.
      disposers.push(
        ctx.get("commands").register({
          name: "hallucination",
          description:
            "Hallucination audit of agent runs (/hallucination [last|show [n]|now|clear])",
          async run(args) {
            const [sub, arg] = args.trim() === "" ? [] : args.trim().split(/\s+/);
            switch (sub ?? "last") {
              case "last": {
                const report = await store.latest();
                if (!report) return "no hallucination audits recorded yet";
                return formatReport(report);
              }
              case "show": {
                const limit = Number.parseInt(arg ?? "10", 10);
                const reports = await store.list();
                if (reports.length === 0) return "no hallucination audits recorded yet";
                const shown = Number.isFinite(limit) && limit > 0 ? reports.slice(-limit) : reports;
                return shown
                  .map((report) => `${report.ts} session=${report.sessionId ?? "?"} ${report.verdict} score=${report.score} findings=${report.findings.length}`)
                  .join("\n");
              }
              case "now": {
                const report = await audit();
                if (!report) return "nothing to audit: no session transcript available";
                return formatReport(report);
              }
              case "clear":
                await store.clear();
                return "hallucination audit reports cleared";
              default:
                return `unknown subcommand "${sub}" (use: last | show [n] | now | clear)`;
            }
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "hallucination-detector.install");
  },
};
