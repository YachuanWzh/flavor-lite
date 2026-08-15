/**
 * flavor-lite public SDK surface.
 *
 * Everything is a plugin: import the kernel and compose your own agent, or
 * use createAgent() for the default composition.
 */

// kernel
export { Context, Runtime, definePlugin, silentLogger, errorMessage } from "./kernel";
export type {
  Disposer,
  EventMap,
  HookMap,
  KernelOptions,
  Logger,
  Plugin,
  PluginContext,
  ServiceMap,
  WaterfallListener,
} from "./kernel/types";

// shared model
export type { Message, ToolCall } from "./shared/messages";
export { messageFootprint, messageText } from "./shared/messages";

// capability plugins
export { llmPlugin, type LlmPluginConfig, type LlmService, type ProviderEntry, type StreamOptions } from "./plugins/llm";
export { OpenAIAdapter, finalizeToolCall, type OpenAIAdapterOptions } from "./plugins/llm/openai";
export { AnthropicAdapter, type AnthropicAdapterOptions } from "./plugins/llm/anthropic";
export { ProviderError, normalizeProviderError, parseModelRef } from "./plugins/llm/types";
export type { ModelAdapter, ModelEvent, ModelRequest, ModelToolSchema, ProviderErrorCode, WireMessage } from "./plugins/llm/types";

export { toolsPlugin, builtinTools } from "./plugins/tools";
export type { AfterToolCall, BeforeToolCall, Tool, ToolCategory, ToolExecuteContext, ToolRegistry, ToolResult } from "./plugins/tools";

export { permissionPlugin, PERMISSION_MODES } from "./plugins/permission";
export type { InteractionService, PermissionMode, PermissionPluginConfig, PermissionService } from "./plugins/permission";

export { sessionPlugin, rewriteSessionFile } from "./plugins/session";
export type { SessionHandle, SessionHeader, SessionInfo, SessionLine, SessionPluginConfig, SessionService } from "./plugins/session";

export { promptPlugin } from "./plugins/prompt";
export type { PromptAssemble, PromptSection, PromptService } from "./plugins/prompt";

export { loopPlugin } from "./plugins/loop";
export type { AgentEvent, AgentRunOptions, AgentService, BeforeLoopRequest, LoopCompact } from "./plugins/loop";

// feature plugins
export { compactionPlugin, compactMessages } from "./plugins/compaction";
export type { CompactionPluginConfig } from "./plugins/compaction";
export { skillsPlugin } from "./plugins/skills";
export type { SkillInfo, SkillsService } from "./plugins/skills";
export { commandsPlugin } from "./plugins/commands";
export type { Command, CommandsService } from "./plugins/commands";
export { initPlugin } from "./plugins/init";

// host composition
export { createAgent } from "./host/bootstrap";
export type { AgentHandle, BootstrapOptions } from "./host/bootstrap";
export { loadConfig, loadDotEnv } from "./host/config";
export type { FlavorConfig } from "./host/config";
export { runRepl } from "./host/repl";
export type { ReplOptions } from "./host/repl";
export { TerminalInteraction } from "./host/interaction";
