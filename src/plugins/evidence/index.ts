import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { ToolEvidence } from "../tools/registry";
import type { CommandsService } from "../commands";

export interface RunEvaluation {
  runId: string;
  baseOutcome: "success" | "provider_error" | "max_iterations" | "aborted";
  successful: boolean;
  score: number;
  evidence: ToolEvidence[];
  reasons: string[];
}

export interface EvidenceService {
  begin(runId: string): void;
  record(runId: string, evidence: ToolEvidence | ToolEvidence[]): void;
  evaluate(runId: string, baseOutcome: RunEvaluation["baseOutcome"], toolErrors: number): RunEvaluation;
  latest(): RunEvaluation | undefined;
  clear(runId: string): void;
  feedback(status: "pass" | "fail", summary: string): RunEvaluation | undefined;
}

class EvidenceStore implements EvidenceService {
  private readonly runs = new Map<string, ToolEvidence[]>();
  private last: RunEvaluation | undefined;

  begin(runId: string): void {
    this.runs.set(runId, []);
    while (this.runs.size > 100) this.runs.delete(this.runs.keys().next().value as string);
  }

  record(runId: string, evidence: ToolEvidence | ToolEvidence[]): void {
    const list = this.runs.get(runId) ?? [];
    list.push(...(Array.isArray(evidence) ? evidence : [evidence]));
    this.runs.set(runId, list.slice(-200));
  }

  evaluate(runId: string, baseOutcome: RunEvaluation["baseOutcome"], toolErrors: number): RunEvaluation {
    const evidence = [...(this.runs.get(runId) ?? [])];
    const requiredFailures = evidence.filter((entry) => entry.required !== false && entry.status === "fail");
    const passes = evidence.filter((entry) => entry.status === "pass").length;
    const failures = evidence.filter((entry) => entry.status === "fail").length;
    const basePass = baseOutcome === "success" && toolErrors === 0;
    const successful = basePass && requiredFailures.length === 0;
    const score = Math.max(0, Math.min(1, (basePass ? 0.5 : 0) + Math.min(0.5, passes * 0.1) - failures * 0.2));
    const reasons = [
      ...(baseOutcome !== "success" ? [`run outcome: ${baseOutcome}`] : []),
      ...(toolErrors > 0 ? [`${toolErrors} tool error${toolErrors === 1 ? "" : "s"}`] : []),
      ...requiredFailures.map((entry) => entry.summary),
    ];
    this.last = { runId, baseOutcome, successful, score, evidence, reasons };
    return this.last;
  }

  latest(): RunEvaluation | undefined {
    return this.last;
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }

  feedback(status: "pass" | "fail", summary: string): RunEvaluation | undefined {
    if (!this.last) return undefined;
    this.last.evidence.push({ kind: "user", status, summary, source: "user", required: true });
    if (status === "fail") {
      this.last.successful = false;
      this.last.score = Math.max(0, this.last.score - 0.5);
      this.last.reasons.push(summary);
    } else {
      this.last.score = Math.min(1, this.last.score + 0.2);
    }
    return this.last;
  }
}

export const evidencePlugin = definePlugin({
  name: "evidence",
  inject: ["commands"],
  provides: ["evidence"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => {
      const service = new EvidenceStore();
      const disposeService = ctx.provide("evidence", service);
      const commands = ctx.get("commands") as CommandsService;
      const disposeCommand = commands.register({
        name: "evidence",
        description: "Inspect or add user task evidence (/evidence show|pass|fail [reason])",
        run(args) {
          const [sub = "show", ...rest] = args.trim().split(/\s+/);
          if (sub === "show") {
            const latest = service.latest();
            return latest ? JSON.stringify(latest, null, 2) : "no completed run evaluation yet";
          }
          if (sub === "pass" || sub === "fail") {
            const summary = rest.join(" ") || (sub === "pass" ? "User accepted the result" : "User rejected the result");
            const latest = service.feedback(sub, summary);
            if (!latest) return "no completed run to annotate";
            const telemetry = ctx.tryGet("telemetry") as { record?: (event: Record<string, unknown>) => void } | undefined;
            telemetry?.record?.({ type: "run.feedback", runId: latest.runId, status: sub, summary });
            return `recorded ${sub} feedback for run ${latest.runId}`;
          }
          return "usage: /evidence show|pass|fail [reason]";
        },
      });
      return () => {
        disposeCommand();
        disposeService();
      };
    }, "evidence.install");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    evidence: EvidenceService;
  }
}
