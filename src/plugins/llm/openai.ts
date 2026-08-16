/**
 * OpenAI-compatible streaming adapter over raw fetch — no SDK, zero extra deps.
 * Works with OpenAI, DeepSeek, Moonshot, vLLM, Ollama, and most gateways.
 */

import type { ToolCall } from "../../shared/messages";
import { readErrorBody, sseFrames } from "./sse";
import type { ModelAdapter, ModelEvent, ModelRequest } from "./types";
import { normalizeProviderError } from "./types";

export interface OpenAIAdapterOptions {
  baseURL: string;
  apiKey: string;
  /** Extra headers for gateways that need them. */
  headers?: Record<string, string>;
}

interface WireToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAIAdapter implements ModelAdapter {
  readonly type = "openai";

  constructor(private readonly options: OpenAIAdapterOptions) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const url = `${this.options.baseURL.replace(/\/$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => toOpenAIMessage(message)),
      ],
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    // Reasoning models (DeepSeek v4/think, ...) spend the max_tokens budget
    // on chain-of-thought first; auxiliary callers can ask to skip it. The
    // `thinking` field is a DeepSeek extension — other gateways ignore it,
    // and OpenAI proper rejects unknown fields nowhere near as eagerly as
    // returning empty content, so this stays opt-in per request.
    if (request.thinking === "disabled") body.thinking = { type: "disabled" };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      throw normalizeProviderError(error);
    }

    if (!response.ok) {
      throw normalizeProviderError(new Error(await readErrorBody(response)), response.status);
    }

    let text = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: "end" | "length" | "tool_calls" = "end";
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const data of sseFrames(response, request.signal)) {
      if (data === "[DONE]") break;
      let parsed: {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: WireToolCallDelta[] };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // keep-alive or malformed frame; skip silently
      }

      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
        };
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const part of delta.tool_calls) {
          const entry = toolCalls.get(part.index) ?? { id: "", name: "", args: "" };
          if (part.id) entry.id = part.id;
          if (part.function?.name) entry.name = part.function.name;
          if (part.function?.arguments) entry.args += part.function.arguments;
          toolCalls.set(part.index, entry);
        }
      }
      if (choice.finish_reason) {
        stopReason =
          choice.finish_reason === "tool_calls" ? "tool_calls"
          : choice.finish_reason === "length" ? "length"
          : "end";
      }
    }

    if (usage) yield { type: "usage", ...usage };
    for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", toolCall: finalizeToolCall(call) };
    }
    yield { type: "done", stopReason };
  }
}

function toOpenAIMessage(message: ModelRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.rawArgs ?? JSON.stringify(call.args) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export function finalizeToolCall(call: { id: string; name: string; args: string }): ToolCall {
  const id = call.id || `call_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const parsed: unknown = call.args.trim() === "" ? {} : JSON.parse(call.args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { id, name: call.name, args: parsed as Record<string, unknown>, rawArgs: call.args };
    }
    return { id, name: call.name, args: {}, rawArgs: call.args };
  } catch {
    // Keep the raw string so the loop can surface a repairable error to the model.
    return { id, name: call.name, args: {}, rawArgs: call.args };
  }
}
