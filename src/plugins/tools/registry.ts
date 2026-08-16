/**
 * Tools capability seam. The registry executes every call through the
 * `tools/before-call` / `tools/after-call` waterfall hooks, so policy
 * plugins (permissions, quotas, logging) intercept without touching the
 * loop — plugins, not loop changes.
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { ToolCall } from "../../shared/messages";
import type { ModelToolSchema } from "../llm/types";
import type { HookBusService } from "../hooks";

export type ToolCategory = "read" | "write" | "shell" | "control";

export interface ToolExecuteContext {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (data: unknown) => void;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  /** JSON Schema object for the arguments. */
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<ToolResult>;
}

/** Waterfall payload before a tool executes. Set block to veto. */
export interface BeforeToolCall {
  toolCall: ToolCall;
  tool: Tool | undefined;
  args: Record<string, unknown>;
  block?: boolean;
  reason?: string;
}

/** Waterfall payload after a tool executed. May rewrite the result. */
export interface AfterToolCall {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface ToolRegistry {
  /** Register a tool. Returns a disposer. Duplicate names fail loud. */
  register(tool: Tool): () => void;
  list(): Tool[];
  get(name: string): Tool | undefined;
  /** JSON schemas for the current model request. */
  schemas(): ModelToolSchema[];
  /** Execute a call through the before/after waterfalls. Never throws. */
  execute(toolCall: ToolCall, ctx: ToolExecuteContext): Promise<ToolResult>;
}

class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private readonly ctx: PluginContext) {}

  register(tool: Tool): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      this.tools.delete(tool.name);
    };
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemas(): ModelToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(toolCall: ToolCall, execCtx: ToolExecuteContext): Promise<ToolResult> {
    const hooks = this.ctx.get("hooks") as HookBusService;
    const tool = this.tools.get(toolCall.name);

    const before = await hooks.waterfall<BeforeToolCall>("tools/before-call", {
      toolCall,
      tool,
      args: toolCall.args,
    });
    if (before.block) {
      return { content: before.reason ?? `Tool "${toolCall.name}" was blocked by policy.`, isError: true };
    }
    // A before-call hook (e.g. the router's L2 recall) may have mounted the
    // tool mid-waterfall: re-resolve before giving up.
    const resolved = tool ?? this.tools.get(toolCall.name);
    if (!resolved) {
      const known = this.list().map((entry) => entry.name).join(", ") || "none";
      return { content: `Tool "${toolCall.name}" not found. Available tools: ${known}`, isError: true };
    }

    let result: ToolResult;
    try {
      result = await resolved.execute(before.args, execCtx);
    } catch (error) {
      result = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    const after = await hooks.waterfall<AfterToolCall>("tools/after-call", {
      toolCall,
      args: before.args,
      result,
    });
    return after.result;
  }
}

export const toolsPlugin = definePlugin({
  name: "tools",
  inject: ["hooks"],
  provides: ["tools"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => ctx.provide("tools", new ToolRegistryImpl(ctx)), "tools.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    tools: ToolRegistry;
  }
  interface HookMap {
    "tools/before-call": BeforeToolCall;
    "tools/after-call": AfterToolCall;
  }
}
