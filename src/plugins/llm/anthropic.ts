/**
 * Anthropic Messages API streaming adapter over raw fetch.
 */

import type { ToolCall } from "../../shared/messages";
import { readErrorBody, sseFrames } from "./sse";
import type { ModelAdapter, ModelEvent, ModelRequest } from "./types";
import { normalizeProviderError } from "./types";

export interface AnthropicAdapterOptions {
  baseURL?: string;
  apiKey: string;
  headers?: Record<string, string>;
}

const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicAdapter implements ModelAdapter {
  readonly type = "anthropic";

  constructor(private readonly options: AnthropicAdapterOptions) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const baseURL = this.options.baseURL ?? "https://api.anthropic.com";
    const url = `${baseURL.replace(/\/$/, "")}/v1/messages`;

    const messages: Record<string, unknown>[] = [];
    for (const message of request.messages) {
      if (message.role === "tool") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          }],
        });
      } else if (message.role === "assistant" && message.toolCalls?.length) {
        const content: Record<string, unknown>[] = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls) {
          let input: unknown = call.args;
          if (call.rawArgs) {
            try { input = JSON.parse(call.rawArgs); } catch { input = {}; }
          }
          content.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      system: request.systemPrompt,
      messages,
      max_tokens: request.maxTokens ?? 8192,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
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

    let stopReason: "end" | "length" | "tool_calls" = "end";
    let currentToolCall: { id: string; name: string; args: string } | undefined;
    const finalized: ToolCall[] = [];

    for await (const data of sseFrames(response, request.signal)) {
      let event: Record<string, any>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            currentToolCall = { id: block.id ?? "", name: block.name ?? "", args: "" };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "input_json_delta" && currentToolCall) {
            currentToolCall.args += delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          if (currentToolCall) {
            finalized.push(finalizeAnthropicToolCall(currentToolCall));
            currentToolCall = undefined;
          }
          break;
        }
        case "message_delta": {
          if (event.usage) {
            yield { type: "usage", inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 };
          }
          const reason = event.delta?.stop_reason;
          stopReason = reason === "tool_use" ? "tool_calls" : reason === "max_tokens" ? "length" : "end";
          break;
        }
        case "message_start": {
          const usage = event.message?.usage;
          if (usage) {
            yield { type: "usage", inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
          }
          break;
        }
        case "error": {
          throw normalizeProviderError(new Error(event.error?.message ?? "anthropic stream error"));
        }
      }
    }

    for (const toolCall of finalized) {
      yield { type: "tool_call", toolCall };
    }
    yield { type: "done", stopReason };
  }
}

function finalizeAnthropicToolCall(call: { id: string; name: string; args: string }): ToolCall {
  try {
    const parsed: unknown = call.args.trim() === "" ? {} : JSON.parse(call.args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { id: call.id, name: call.name, args: parsed as Record<string, unknown>, rawArgs: call.args };
    }
    return { id: call.id, name: call.name, args: {}, rawArgs: call.args };
  } catch {
    return { id: call.id, name: call.name, args: {}, rawArgs: call.args };
  }
}
