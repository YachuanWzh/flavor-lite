// Type declarations for analyzer.js (tests import it as TS).

export interface ToolCallLike {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export type Severity = "low" | "medium" | "high";

export type Stage =
  | "input-planning"
  | "tool-execution"
  | "reasoning"
  | "memory-state"
  | "process"
  | "output-grounding";

export interface Finding {
  rule: string;
  severity: Severity;
  stage: Stage;
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolTraceEntry {
  toolCall: ToolCallLike;
  result: string;
  isError: boolean;
  hash: string;
}

export interface RunTrace {
  userRequests: string[];
  toolTrace: ToolTraceEntry[];
  assistantTexts: string[];
  events: Array<{ kind: "tool" | "text"; index: number }>;
  steeringCount: number;
  compacted: boolean;
  finalAnswer: string;
}

export interface RepeatConfig {
  windowSize?: number;
  threshold?: number;
}

export interface JudgeResult {
  aligned: boolean;
  score: number;
  issues: Array<{ stage: Stage; severity: Severity; message: string }>;
}

export interface AuditReport {
  sessionId?: string;
  ts: string;
  score: number;
  verdict: "clean" | "suspect" | "likely-hallucinated";
  findings: Finding[];
  stats: {
    toolCalls: number;
    assistantMessages: number;
    compacted: boolean;
    steering: number;
    judgeScore?: number;
  };
}

export const SEVERITY_WEIGHT: Record<Severity, number>;
export const STAGES: Stage[];
export const DEFAULT_REPEAT: { windowSize: number; threshold: number };

export function canonicalize(value: unknown): unknown;
export function toolCallHash(toolCall: ToolCallLike): string;
export function detectRepeatWindows(hashes: string[], config?: RepeatConfig): Array<{ hash: string; count: number }>;
export function extractTrace(messages: Array<Record<string, unknown>>): RunTrace;
export function detectFlipFlopEdits(trace: RunTrace): Finding[];
export function detectIgnoredFailures(trace: RunTrace): Finding[];
export function detectResultMisread(trace: RunTrace): Finding[];
export function detectContradictions(trace: RunTrace): Finding[];
export function detectMemoryRisks(trace: RunTrace): Finding[];
export function detectRedundantExploration(trace: RunTrace): Finding[];
export function detectDeadEndChains(trace: RunTrace): Finding[];
export function extractMentionedFiles(text: string): string[];
export function extractMentionedCommands(text: string): string[];
export function detectUngroundedClaims(trace: RunTrace): Finding[];
export function buildJudgePrompt(trace: RunTrace, maxChars?: number): string;
export function parseJudgeReply(raw: string): JudgeResult | undefined;
export function scoreFindings(findings: Finding[]): number;
export function verdictFor(score: number): AuditReport["verdict"];
export function analyzeRun(
  trace: RunTrace,
  options?: { repeat?: RepeatConfig; judge?: JudgeResult },
): AuditReport;
export function formatReport(report: AuditReport): string;
export function truncate(text: string, max: number): string;
