/**
 * Type declarations for records.js — kept in sync with the implementation
 * so tests can import the JS module type-safely.
 */

export type ErrorKind =
  | "shell_exit"
  | "shell_spawn"
  | "shell_timeout"
  | "tool_not_found"
  | "tool_blocked"
  | "invalid_args"
  | "network"
  | "file"
  | "unknown";

export interface ErrorRecord {
  id: string;
  tool: string;
  kind: ErrorKind;
  signature: string;
  command?: string;
  detail: string;
  lesson: string;
  /** LLM-produced analysis of the failure (attached after analysis runs). */
  analysis?: string;
  /** Confidence score (0-1) the LLM assigned to its analysis. */
  confidence?: number;
  /** Why the LLM analysis failed, when it did (surfaced by /errors). */
  analysisError?: string;
  /**
   * Long-term-memory outcome of the distillation attempt: "stored" or
   * "skipped:<reason>" (surfaced by /errors; hosts commonly run with a
   * silent logger, so this is the durable diagnostic channel).
   */
  memoryStatus?: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface RecordOutcome {
  added: boolean;
  ignored: boolean;
  record?: ErrorRecord;
}

export interface ErrorRecordStoreOptions {
  workspace: string;
  logger?: { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void };
  recordsDir?: string;
  maxRecords?: number;
  maxDetailChars?: number;
  maxLessonChars?: number;
  ignorePatterns?: string[];
  enabled?: boolean;
}

export class ErrorRecordStore {
  readonly workspace: string;
  readonly path: string;
  constructor(options: ErrorRecordStoreOptions);
  record(input: { tool: string; args?: Record<string, unknown>; result: { content?: unknown; isError?: boolean } }): Promise<RecordOutcome>;
  attachAnalysis(id: string, analysis: string, confidence: number): Promise<RecordOutcome>;
  attachAnalysisError(id: string, reason: string): Promise<RecordOutcome>;
  attachMemoryStatus(id: string, status: string): Promise<RecordOutcome>;
  list(): Promise<ErrorRecord[]>;
  lessons(max?: number, maxChars?: number): Promise<string[]>;
  clear(): Promise<boolean>;
}

export function redactSecrets(text: string): string;
export function classifyError(content: string): ErrorKind;
export function extractErrorLine(content: string): string;
export function windowsShellHints(content: string): string[];
export function buildLesson(input: { tool: string; kind: ErrorKind; content: string; command?: string; platform?: string }): string;
