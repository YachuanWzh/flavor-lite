/**
 * Bootstrap: the composition root. Mounts every plugin on the kernel and
 * exposes a small AgentHandle. This is the only place that knows the full
 * plugin list — hosts and SDK users may swap any part of it.
 */

import { Runtime, type Logger, type Plugin } from "../kernel";
import { hooksPlugin } from "../plugins/hooks";
import { llmPlugin, type LlmService } from "../plugins/llm";
import { anthropicProviderPlugin, openaiProviderPlugin } from "../plugins/llm/providers";
import { builtinTools, toolsPlugin } from "../plugins/tools";
import { guidancePlugins } from "../plugins/guidance";
import { permissionPlugin, type PermissionMode } from "../plugins/permission";
import { sessionPlugin } from "../plugins/session";
import { promptPlugin } from "../plugins/prompt";
import { loopPlugin, type AgentEvent, type AgentRunOptions, type AgentService } from "../plugins/loop";
import { compactionPlugin } from "../plugins/compaction";
import { skillsPlugin } from "../plugins/skills";
import { commandsPlugin } from "../plugins/commands";
import { initPlugin } from "../plugins/init";
import { pluginsLoaderPlugin } from "../plugins/plugins";
import { loadConfig, type FlavorConfig } from "./config";

export interface BootstrapOptions {
  cwd?: string;
  /** Config overrides; merged over files + env (see host/config). */
  config?: FlavorConfig;
  logger?: Logger;
  /** Extra plugins mounted after the defaults (custom providers, policies, hosts). */
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

  runtime
    .use(hooksPlugin)
    .use(llmPlugin, {
      ...(config.model ? { model: config.model } : {}),
    })
    // Provider discovery is delegated to plugins: each self-registers its
    // adapter when credentials exist and skips otherwise. The composition
    // root never touches adapters or environment variables.
    .use(openaiProviderPlugin, config.openai ?? {})
    .use(anthropicProviderPlugin, config.anthropic ?? {})
    .use(toolsPlugin);
  // Guidance first so its sections lead the prompt; permission and tool
  // plugins contribute their own sections where they mount.
  for (const guidance of guidancePlugins) runtime.use(guidance);
  for (const toolPlugin of builtinTools) runtime.use(toolPlugin);
  runtime
    .use(permissionPlugin, { ...(config.mode ? { mode: config.mode as PermissionMode } : {}) })
    .use(sessionPlugin)
    .use(promptPlugin)
    .use(loopPlugin)
    .use(compactionPlugin, {})
    .use(skillsPlugin)
    .use(commandsPlugin)
    .use(initPlugin)
    // Disk plugin discovery (.flavorlite/plugins). Mounts last so loaded
    // plugins can inject every default service; hosts call init() after
    // start() since discovery is async.
    .use(pluginsLoaderPlugin, { runtime });
  for (const extra of options.plugins ?? []) runtime.use(extra.plugin, extra.config);
  runtime.start();

  // Generic provider check: whichever plugins registered adapters count,
  // built-in or third-party. Fail loud at startup, never mid-conversation.
  const llm = runtime.ctx.get("llm") as LlmService;
  if (llm.providers().length === 0) {
    throw new Error(
      "No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (see .env.example), or mount a provider plugin.",
    );
  }

  const agent = runtime.ctx.get("agent") as AgentService;
  return {
    runtime,
    run: (runOptions) => agent.run(runOptions),
    steer: (text) => agent.steer(text),
    dispose: () => runtime.dispose(),
  };
}
