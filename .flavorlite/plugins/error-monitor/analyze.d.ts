/**
 * Type declarations for analyze.js — kept in sync with the implementation
 * so tests can import the JS module type-safely.
 */

import type { ErrorKind, ErrorRecord } from "./records.js";

export interface AnalysisEnvironment {
  platform: string;
  arch: string;
  node: string;
  shell: string;
  cwd: string;
  [key: string]: unknown;
}

export interface AnalysisInput {
  record: ErrorRecord & { content?: string; args?: Record<string, unknown> };
  environment?: AnalysisEnvironment;
  includeArgs?: boolean;
  maxAnalysisChars?: number;
}

export interface AnalysisConfig {
  model?: string;
  maxTokens?: number;
  maxAnalysisChars?: number;
  /** Abort the LLM stream after this many ms (default 20000). */
  timeoutMs?: number;
  /** Extra attempts after the first (default 1 → up to 2 total calls). */
  retryCount?: number;
  /** Delay between retries, scaled by attempt (default 400ms). */
  retryBackoffMs?: number;
  includeArgs?: boolean;
}

export type AnalysisResult =
  | { status: "success"; analysis: string; confidence: number }
  | { status: "error"; reason: string };

export interface LlmLike {
  stream(options: {
    model?: string;
    systemPrompt: string;
    messages: Array<{ role: "user"; content: string }>;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<{ type: string; text?: string }>;
}

export function buildEnvironmentInfo(extra?: Record<string, unknown>): AnalysisEnvironment;
export function buildAnalysisPrompt(input: AnalysisInput): string;
export function parseAnalysisResult(raw: string): { analysis: string; confidence: number } | undefined;
export function analyzeWithLlm(input: {
  llm: LlmLike;
  record: AnalysisInput["record"];
  environment?: AnalysisEnvironment;
  config?: AnalysisConfig;
}): Promise<AnalysisResult>;
export function collectLlmText(
  llm: LlmLike,
  options: Parameters<LlmLike["stream"]>[0],
  timeoutMs?: number,
): Promise<string | undefined>;
