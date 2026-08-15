/**
 * Provider discovery, as plugins. Each provider plugin self-registers its
 * adapter on the `llm` service when credentials are present and silently
 * skips otherwise — mount both, whatever has credentials activates. Third
 * parties follow the same shape, so the composition root never learns
 * about adapters or environment variables.
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import { AnthropicAdapter } from "./anthropic";
import type { LlmService } from "./index";
import { OpenAIAdapter } from "./openai";

export interface ProviderPluginConfig {
  apiKey?: string;
  baseURL?: string;
  /** Default model for this provider (bare model name, not a "provider:model" ref). */
  model?: string;
}

export const openaiProviderPlugin = definePlugin<ProviderPluginConfig>({
  name: "provider:openai",
  inject: ["llm"],
  apply(ctx: PluginContext, config: ProviderPluginConfig = {}) {
    if (!config.apiKey) return; // no credentials → provider absent; the host's generic check fails loud
    return ctx.effect(
      () =>
        (ctx.get("llm") as LlmService).registerAdapter(
          "openai",
          new OpenAIAdapter({
            apiKey: config.apiKey!,
            baseURL: config.baseURL ?? "https://api.openai.com/v1",
          }),
          config.model,
        ),
      "provider:openai.register",
    );
  },
});

export const anthropicProviderPlugin = definePlugin<ProviderPluginConfig>({
  name: "provider:anthropic",
  inject: ["llm"],
  apply(ctx: PluginContext, config: ProviderPluginConfig = {}) {
    if (!config.apiKey) return;
    return ctx.effect(
      () =>
        (ctx.get("llm") as LlmService).registerAdapter(
          "anthropic",
          new AnthropicAdapter({
            apiKey: config.apiKey!,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          }),
          config.model,
        ),
      "provider:anthropic.register",
    );
  },
});
