/**
 * Bootstrap: the composition root. Mounts every plugin on the kernel and
 * exposes a small AgentHandle. This is the only place that knows the full
 * plugin list — hosts and SDK users may swap any part of it.
 */

import { Runtime, type Logger, type Plugin } from "../kernel";
import { AnthropicAdapter } from "../plugins/llm/anthropic";
import { llmPlugin, type LlmPluginConfig } from "../plugins/llm";
import { OpenAIAdapter } from "../plugins/llm/openai";
import type { ModelAdapter } from "../plugins/llm/types";
import { builtinTools, toolsPlugin } from "../plugins/tools";
import { permissionPlugin, type InteractionService, type PermissionMode } from "../plugins/permission";
import { sessionPlugin } from "../plugins/session";
import { promptPlugin } from "../plugins/prompt";
import { loopPlugin, type AgentEvent, type AgentRunOptions, type AgentService } from "../plugins/loop";
import { compactionPlugin } from "../plugins/compaction";
import { skillsPlugin } from "../plugins/skills";
import { commandsPlugin } from "../plugins/commands";
import { initPlugin } from "../plugins/init";
import { loadConfig, type FlavorConfig } from "./config";

export interface BootstrapOptions {
  cwd?: string;
  /** Config overrides; merged over files + env (see host/config). */
  config?: FlavorConfig;
  logger?: Logger;
  /** Terminal approval provider; without it, non-bypass writes are blocked. */
  interaction?: InteractionService;
  /** Extra plugins mounted after the defaults. */
  plugins?: Array<{ plugin: Plugin<never>; config?: never }>;
}

export interface AgentHandle {
  readonly runtime: Runtime;
  /** Run one user turn through the loop. */
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Inject a steering message for the next model request. */
  steer(text: string): void;
  dispose(): Promise<void>;
}

export function createAgent(options: BootstrapOptions = {}): AgentHandle {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd, options.config);

  const runtime = Runtime.create({
    cwd,
    ...(options.logger ? { logger: options.logger } : {}),
  });

  // LLM providers: mount adapters for whatever credentials are present.
  const providers: LlmPluginConfig["providers"] = {};
  if (config.openai?.apiKey) {
    providers.openai = {
      adapter: new OpenAIAdapter({
        apiKey: config.openai.apiKey,
        baseURL: config.openai.baseURL ?? "https://api.openai.com/v1",
      }) satisfies ModelAdapter,
      ...(config.openai.model ? { defaultModel: config.openai.model } : {}),
    };
  }
  if (config.anthropic?.apiKey) {
    providers.anthropic = {
      adapter: new AnthropicAdapter({
        apiKey: config.anthropic.apiKey,
        ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
      }) satisfies ModelAdapter,
      ...(config.anthropic.model ? { defaultModel: config.anthropic.model } : {}),
    };
  }
  if (Object.keys(providers).length === 0) {
    // Fail loud at startup, never mid-conversation.
    throw new Error(
      "No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (see .env.example).",
    );
  }

  runtime
    .use(llmPlugin, {
      providers,
      ...(config.model ? { model: config.model } : {}),
    })
    .use(toolsPlugin);
  for (const toolPlugin of builtinTools) runtime.use(toolPlugin);
  runtime
    .use(permissionPlugin, { ...(config.mode ? { mode: config.mode as PermissionMode } : {}) })
    .use(sessionPlugin)
    .use(promptPlugin)
    .use(loopPlugin)
    .use(compactionPlugin, {})
    .use(skillsPlugin)
    .use(commandsPlugin)
    .use(initPlugin);
  for (const extra of options.plugins ?? []) runtime.use(extra.plugin, extra.config);
  runtime.start();

  if (options.interaction) {
    runtime.ctx.provide("interaction", options.interaction);
  }

  const agent = runtime.ctx.get("agent") as AgentService;
  return {
    runtime,
    run: (runOptions) => agent.run(runOptions),
    steer: (text) => agent.steer(text),
    dispose: () => runtime.dispose(),
  };
}
