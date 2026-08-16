/**
 * The llm plugin: claims `ctx.llm`, hosts a registry of streaming adapters,
 * and resolves "provider:model" refs. Adapters themselves are registrations —
 * other plugins may add custom providers via ctx.llm.registerAdapter().
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { Message } from "../../shared/messages";
import type { ModelAdapter, ModelEvent, ModelRequest, ModelToolSchema, WireMessage } from "./types";
import { parseModelRef } from "./types";

export interface ProviderEntry {
  adapter: ModelAdapter;
  defaultModel?: string;
}

export interface StreamOptions {
  /** "provider:model" ref; falls back to the configured default. */
  model?: string;
  systemPrompt: string;
  messages: Message[];
  tools?: ModelToolSchema[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** "disabled" skips reasoning-model chain-of-thought where supported. */
  thinking?: "disabled" | "auto";
}

export interface LlmService {
  /** Register or replace an adapter under a provider key. Returns a disposer. */
  registerAdapter(key: string, adapter: ModelAdapter, defaultModel?: string): () => void;
  /** The provider keys currently registered. */
  providers(): string[];
  /** Resolve a ref to concrete { provider, model } using defaults. */
  resolve(ref?: string): { provider: string; model: string };
  /** Stream a request. Throws ProviderError on failure. */
  stream(options: StreamOptions): AsyncIterable<ModelEvent>;
  /** Current default model ref ("provider:model"). */
  defaultRef(): string | undefined;
  /** Change the default model ref at runtime (/model command). */
  setDefaultRef(ref: string): void;
}

export interface LlmPluginConfig {
  /**
   * Pre-registered adapters. The default composition leaves this empty and
   * lets provider plugins self-register; tests and SDK users may seed it.
   */
  providers?: Record<string, { adapter: ModelAdapter; defaultModel?: string }>;
  /** Default model ref, "provider:model" form. */
  model?: string;
}

class LlmServiceImpl implements LlmService {
  private adapters = new Map<string, ProviderEntry>();
  private defaultModelRef: string | undefined;

  constructor(config: LlmPluginConfig) {
    for (const [key, entry] of Object.entries(config.providers ?? {})) {
      this.adapters.set(key, { adapter: entry.adapter, defaultModel: entry.defaultModel });
    }
    this.defaultModelRef = config.model;
  }

  registerAdapter(key: string, adapter: ModelAdapter, defaultModel?: string): () => void {
    const previous = this.adapters.get(key);
    this.adapters.set(key, { adapter, ...(defaultModel !== undefined ? { defaultModel } : {}) });
    return () => {
      if (previous) this.adapters.set(key, previous);
      else this.adapters.delete(key);
    };
  }

  providers(): string[] {
    return [...this.adapters.keys()];
  }

  resolve(ref?: string): { provider: string; model: string } {
    const effective = ref ?? this.defaultModelRef;
    if (!effective) {
      // No explicit ref: use the first provider with a default model so a
      // bare env-var setup works without configuration.
      for (const [provider, entry] of this.adapters) {
        if (entry.defaultModel) return { provider, model: entry.defaultModel };
      }
      throw new Error(
        "No model configured. Set FLAVOR_MODEL or a provider defaultModel (see .env.example).",
      );
    }
    return parseModelRef(effective);
  }

  defaultRef(): string | undefined {
    if (this.defaultModelRef) return this.defaultModelRef;
    for (const [provider, entry] of this.adapters) {
      if (entry.defaultModel) return `${provider}:${entry.defaultModel}`;
    }
    return undefined;
  }

  setDefaultRef(ref: string): void {
    const { provider } = parseModelRef(ref);
    if (!this.adapters.has(provider)) {
      throw new Error(`unknown provider "${provider}" (available: ${this.providers().join(", ") || "none"})`);
    }
    this.defaultModelRef = ref;
  }

  async *stream(options: StreamOptions): AsyncIterable<ModelEvent> {
    const { provider, model } = this.resolve(options.model);
    const entry = this.adapters.get(provider);
    if (!entry) {
      throw new Error(`unknown provider "${provider}" (available: ${this.providers().join(", ") || "none"})`);
    }
    const request: ModelRequest = {
      model,
      systemPrompt: options.systemPrompt,
      messages: options.messages.map(toWireMessage),
      tools: options.tools ?? [],
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
    };
    yield* entry.adapter.stream(request);
  }
}

function toWireMessage(message: Message): WireMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    return message.toolCalls
      ? { role: "assistant", content: message.content, toolCalls: message.toolCalls }
      : { role: "assistant", content: message.content };
  }
  return { role: "user", content: message.content };
}

export const llmPlugin = definePlugin<LlmPluginConfig>({
  name: "llm",
  provides: ["llm"],
  apply(ctx: PluginContext, config: LlmPluginConfig = {}) {
    return ctx.effect(() => ctx.provide("llm", new LlmServiceImpl(config)), "llm.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    llm: LlmService;
  }
}
