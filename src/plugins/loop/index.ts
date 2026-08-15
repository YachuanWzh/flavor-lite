/**
 * The agent loop, as a plugin. It consumes capability seams only —
 * `llm`, `tools`, `systemPrompt`, optional `session` — so every policy and
 * behavior lives in other plugins (plugins, not loop changes).
 *
 * Loop behavior (pi-inspired):
 * - event-driven streaming: run() yields AgentEvents as they happen
 * - steering: steer() injects a user message mid-loop without restarting
 * - retries: network/rate_limit backoff x3 when the turn produced nothing
 * - context_overflow: asks the `loop/compact` waterfall once, then retries
 * - warnings: emitted at 80% of maxIterations and on stopReason=length
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { Message, ToolCall } from "../../shared/messages";
import { ProviderError, normalizeProviderError } from "../llm/types";
import type { ModelToolSchema } from "../llm/types";
import type { SessionHandle, SessionService } from "../session";
import type { ToolRegistry } from "../tools/registry";
import type { LlmService } from "../llm";
import type { PromptService } from "../prompt";

export type AgentEvent =
  | { type: "agent_start"; sessionId?: string; model?: string }
  | { type: "turn_start"; iteration: number }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; message: Extract<Message, { role: "assistant" }> }
  | { type: "tool_start"; toolCall: ToolCall }
  | { type: "tool_end"; toolCall: ToolCall; content: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "warning"; message: string }
  | { type: "agent_end"; iterations: number; reason: "finished" | "max_iterations" | "aborted" };

export interface AgentRunOptions {
  input: string;
  /** "provider:model" override for this run only. */
  model?: string;
  /** Resume/continue within an existing session; a new one is created otherwise. */
  session?: SessionHandle;
  signal?: AbortSignal;
  maxIterations?: number;
  maxTokens?: number;
}

export interface AgentService {
  /** Run one user turn through the loop. Yields events; never throws for provider errors mid-stream. */
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Inject a steering message picked up before the next model request (pi-style). */
  steer(text: string): void;
}

/** Waterfall payload before every model request. Compaction hooks in here. */
export interface BeforeLoopRequest {
  messages: Message[];
  systemPrompt: string;
  tools: ModelToolSchema[];
}

/** Waterfall payload when the context overflows. Plugins may trim `messages`. */
export interface LoopCompact {
  messages: Message[];
}

const DEFAULT_MAX_ITERATIONS = 30;
const WARN_RATIO = 0.8;
const MAX_RETRIES = 3;

class AgentServiceImpl implements AgentService {
  private steeringQueue: string[] = [];

  constructor(private readonly ctx: PluginContext) {}

  steer(text: string): void {
    this.steeringQueue.push(text);
  }

  async *run(options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const llm = this.ctx.get("llm") as LlmService;
    const tools = this.ctx.get("tools") as ToolRegistry;
    const prompt = this.ctx.get("systemPrompt") as PromptService;
    const sessionService = this.ctx.tryGet("session") as SessionService | undefined;

    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const session = options.session ?? (sessionService ? await sessionService.create() : undefined);
    const messages: Message[] = session ? [...session.messages()] : [];
    const systemPrompt = await prompt.assemble();
    const toolSchemas = tools.schemas();

    yield { type: "agent_start", sessionId: session?.id, model: llm.defaultRef() };

    // Log the user turn first: model-visible ⇔ logged.
    await this.record(session, messages, { role: "user", content: options.input });
    void session?.setTitle(firstLine(options.input).slice(0, 80)).catch(() => {});

    let warned = false;
    let compacted = false;
    let iteration = 0;

    while (iteration < maxIterations) {
      if (options.signal?.aborted) {
        yield { type: "agent_end", iterations: iteration, reason: "aborted" };
        return;
      }
      iteration += 1;
      yield { type: "turn_start", iteration };
      if (!warned && iteration >= maxIterations * WARN_RATIO) {
        warned = true;
        yield { type: "warning", message: `Approaching the iteration limit (${maxIterations}).` };
      }

      // Steering messages join the conversation before the next request.
      while (this.steeringQueue.length > 0) {
        const text = this.steeringQueue.shift();
        if (text) await this.record(session, messages, { role: "user", content: `[steering] ${text}` });
      }

      const request = await this.ctx.waterfall<BeforeLoopRequest>("loop/before-request", {
        messages: [...messages],
        systemPrompt,
        tools: toolSchemas,
      });

      const channel = new EventChannel();
      const turnPromise = this.requestTurn(llm, request, options, channel);
      // Stream turn events (text_delta, usage) to the caller in real time.
      for await (const event of channel) yield event;
      const turn = await turnPromise;
      if (turn.error) {
        const error = turn.error;
        if (error.code === "context_overflow" && !compacted) {
          // Give compaction plugins one shot at trimming the history.
          const compactedPayload = await this.ctx.waterfall<LoopCompact>("loop/compact", {
            messages: [...messages],
          });
          if (compactedPayload.messages.length < messages.length) {
            compacted = true;
            messages.length = 0;
            messages.push(...compactedPayload.messages);
            iteration -= 1; // the retry of this turn should not count
            yield { type: "warning", message: "Context overflow: history was compacted, retrying." };
            continue;
          }
        }
        yield { type: "warning", message: `Model request failed (${error.code}): ${error.message}` };
        yield { type: "agent_end", iterations: iteration, reason: "finished" };
        return;
      }

      const assistantMessage: Extract<Message, { role: "assistant" }> =
        turn.toolCalls.length > 0
          ? { role: "assistant", content: turn.text, toolCalls: turn.toolCalls }
          : { role: "assistant", content: turn.text };
      await this.record(session, messages, assistantMessage);
      yield { type: "message_end", message: assistantMessage };

      if (turn.toolCalls.length === 0) {
        yield { type: "agent_end", iterations: iteration, reason: "finished" };
        return;
      }
      if (turn.stopReason === "length") {
        yield { type: "warning", message: "Model response hit the token limit; continuing with tool results." };
      }

      for (const toolCall of turn.toolCalls) {
        if (options.signal?.aborted) break;
        yield { type: "tool_start", toolCall };
        const result = await tools.execute(toolCall, {
          cwd: this.ctx.cwd,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        await this.record(session, messages, {
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
        yield { type: "tool_end", toolCall, content: result.content, isError: Boolean(result.isError) };
      }
    }

    yield { type: "agent_end", iterations: iteration, reason: "max_iterations" };
  }

  /**
   * One model request with streaming. text_delta/usage events are pushed to
   * the channel as they arrive. Retries network/rate_limit failures with
   * exponential backoff as long as nothing was emitted yet (fast path stays
   * fast; partial turns are never silently duplicated).
   */
  private async requestTurn(
    llm: LlmService,
    request: BeforeLoopRequest,
    options: AgentRunOptions,
    channel: EventChannel,
  ): Promise<
    | { text: string; toolCalls: ToolCall[]; stopReason?: "end" | "length" | "tool_calls"; error?: undefined }
    | { error: ProviderError; text: string; toolCalls: ToolCall[] }
  > {
    let attempt = 0;
    let emitted = false;
    for (;;) {
      attempt += 1;
      let text = "";
      const toolCalls: ToolCall[] = [];
      let stopReason: "end" | "length" | "tool_calls" | undefined;
      try {
        const stream = llm.stream({
          ...(options.model ? { model: options.model } : {}),
          systemPrompt: request.systemPrompt,
          messages: request.messages,
          tools: request.tools,
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        for await (const event of stream) {
          if (event.type === "text_delta") {
            text += event.text;
            emitted = true;
            channel.push({ type: "text_delta", text: event.text });
          } else if (event.type === "tool_call") {
            toolCalls.push(event.toolCall);
          } else if (event.type === "usage") {
            emitted = true;
            channel.push({ type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens });
          } else if (event.type === "done") {
            stopReason = event.stopReason;
          }
        }
        channel.close();
        return { text, toolCalls, stopReason };
      } catch (rawError) {
        const error = normalizeProviderError(rawError);
        const retryable = (error.code === "network" || error.code === "rate_limit") && !emitted;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        channel.close();
        return { error, text, toolCalls };
      }
    }
  }

  private async record(
    session: SessionHandle | undefined,
    messages: Message[],
    message: Message,
  ): Promise<void> {
    messages.push(message);
    if (session) await session.append(message);
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

/** Minimal single-consumer async queue bridging push-based streams and generators. */
class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private closed = false;
  private waiter: (() => void) | undefined;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    this.waiter?.();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loopPlugin = definePlugin({
  name: "loop",
  inject: ["llm", "tools", "systemPrompt"],
  provides: ["agent"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => ctx.provide("agent", new AgentServiceImpl(ctx)), "loop.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    agent: AgentService;
  }
  interface HookMap {
    "loop/before-request": BeforeLoopRequest;
    "loop/compact": LoopCompact;
  }
}
