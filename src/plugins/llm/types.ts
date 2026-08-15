/**
 * LLM capability seam. Mirrors flavor-code's ModelAdapter idea: providers are
 * interchangeable streaming adapters behind one service, resolved by
 * "provider:model" refs.
 */

import type { ToolCall } from "../../shared/messages";

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  systemPrompt: string;
  /** Serialized provider-neutral history; adapters convert to their wire format. */
  messages: WireMessage[];
  tools: ModelToolSchema[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Wire-level message — already flattened for provider payloads. */
export type WireMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ProviderErrorCode =
  | "authentication"
  | "rate_limit"
  | "context_overflow"
  | "model_not_found"
  | "network"
  | "cancelled"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: "end" | "length" | "tool_calls" };

export interface ModelAdapter {
  readonly type: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Same normalization heuristics as flavor-code, tuned for raw fetch errors. */
export function normalizeProviderError(error: unknown, status?: number): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("cancelled", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  const searchable = message.toLowerCase();

  if (status === 401 || status === 403 || /auth|api.?key|unauthorized/.test(searchable)) {
    return new ProviderError("authentication", message, status);
  }
  if (status === 429 || /rate.?limit|overloaded|too many requests/.test(searchable)) {
    return new ProviderError("rate_limit", message, status);
  }
  if (/context|too many tokens|prompt is too long|maximum context/.test(searchable)) {
    return new ProviderError("context_overflow", message, status);
  }
  if (status === 404 || /model.*not.?found|does not exist/.test(searchable)) {
    return new ProviderError("model_not_found", message, status);
  }
  if (status === undefined && /econn|enet|socket|network|fetch failed|timeout|undici/.test(searchable)) {
    return new ProviderError("network", message);
  }
  return new ProviderError("unknown", message, status);
}

/** Parse the "provider:model" reference form. Bare names default to "openai". */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const index = ref.indexOf(":");
  if (index <= 0) return { provider: "openai", model: ref };
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}
