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
import { currentOwnerScope } from "../../kernel/context";

export type ToolCategory = "read" | "write" | "shell" | "control";

export interface ToolExecuteContext {
  cwd: string;
  runId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: (data: unknown) => void;
}

export interface ArtifactRef {
  id: string;
  path: string;
  mimeType?: string;
  size?: number;
  description?: string;
}

export interface ToolDiagnostic {
  message: string;
  severity?: "info" | "warning" | "error";
  path?: string;
  line?: number;
  code?: string;
}

export interface ToolEvidence {
  kind: "verification" | "test" | "typecheck" | "build" | "lint" | "diff" | "user" | "claim" | "custom";
  status: "pass" | "fail" | "info";
  summary: string;
  source?: string;
  required?: boolean;
  data?: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Optional machine-readable payload; providers still receive content. */
  data?: unknown;
  /** Large or durable outputs stored outside the model transcript. */
  artifacts?: ArtifactRef[];
  diagnostics?: ToolDiagnostic[];
  /** Evidence consumed by the run evaluator. */
  evidence?: ToolEvidence[];
  truncated?: boolean;
  continuation?: string;
  retryable?: boolean;
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
  context?: ToolExecuteContext;
  block?: boolean;
  reason?: string;
}

/** Waterfall payload after a tool executed. May rewrite the result. */
export interface AfterToolCall {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  result: ToolResult;
  context?: ToolExecuteContext;
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
  /** Settle when every currently executing tool call has returned. */
  whenIdle(timeoutMs?: number): Promise<void>;
  inFlight(): number;
}

export interface ToolsPluginConfig {
  /** Hard cap for inline tool output. Full content is persisted as an artifact when the artifact service is mounted. */
  maxOutputChars?: number;
}

interface ArtifactStoreLike {
  put(content: string, options?: { runId?: string; mimeType?: string; description?: string }): Promise<ArtifactRef>;
}

class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, { tool: Tool; owner?: string; registration: number }>();
  private nextRegistration = 0;
  private activeCalls = 0;
  private idleWaiters = new Set<() => void>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly maxOutputChars: number,
  ) {}

  register(tool: Tool): () => void {
    const scope = currentOwnerScope();
    const current = this.tools.get(tool.name);
    const takeover = current !== undefined && scope?.replaceOwner !== undefined && current.owner === scope.replaceOwner;
    if (current && !takeover) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    const registration = this.nextRegistration++;
    this.tools.set(tool.name, { tool, owner: scope?.owner, registration });
    return () => {
      if (this.tools.get(tool.name)?.registration === registration) this.tools.delete(tool.name);
    };
  }

  list(): Tool[] {
    return [...this.tools.values()].map((entry) => entry.tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
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
    const tool = this.tools.get(toolCall.name)?.tool;

    const before = await hooks.waterfall<BeforeToolCall>("tools/before-call", {
      toolCall,
      tool,
      args: toolCall.args,
      context: execCtx,
    });
    if (before.block) {
      return { content: before.reason ?? `Tool "${toolCall.name}" was blocked by policy.`, isError: true };
    }
    // A before-call hook (e.g. the router's L2 recall) may have mounted the
    // tool mid-waterfall: re-resolve before giving up.
    const resolved = tool ?? this.tools.get(toolCall.name)?.tool;
    if (!resolved) {
      const known = this.list().map((entry) => entry.name).join(", ") || "none";
      return { content: `Tool "${toolCall.name}" not found. Available tools: ${known}`, isError: true };
    }

    let result: ToolResult;
    try {
      this.activeCalls += 1;
      try {
        result = await resolved.execute(before.args, execCtx);
      } finally {
        this.activeCalls -= 1;
        if (this.activeCalls === 0) {
          for (const resolveIdle of this.idleWaiters) resolveIdle();
          this.idleWaiters.clear();
        }
      }
    } catch (error) {
      result = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    result = await this.boundOutput(result, execCtx);
    const after = await hooks.waterfall<AfterToolCall>("tools/after-call", {
      toolCall,
      args: before.args,
      result,
      context: execCtx,
    });
    return after.result;
  }

  inFlight(): number {
    return this.activeCalls;
  }

  async whenIdle(timeoutMs = 30_000): Promise<void> {
    if (this.activeCalls === 0) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(done);
        rejectPromise(new Error(`timed out waiting for ${this.activeCalls} in-flight tool call(s)`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      this.idleWaiters.add(done);
    });
  }

  private async boundOutput(result: ToolResult, execCtx: ToolExecuteContext): Promise<ToolResult> {
    if (result.content.length <= this.maxOutputChars) return result;
    const full = result.content;
    const artifacts = [...(result.artifacts ?? [])];
    const store = this.ctx.tryGet("artifacts") as ArtifactStoreLike | undefined;
    if (store) {
      try {
        artifacts.push(
          await store.put(full, {
            ...(execCtx.runId ? { runId: execCtx.runId } : {}),
            mimeType: "text/plain",
            description: "Full tool output truncated from the model transcript",
          }),
        );
      } catch (error) {
        this.ctx.logger.warn(`failed to persist oversized tool output: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const suffix = artifacts.at(-1)?.path
      ? `\n\n[output truncated; full artifact: ${artifacts.at(-1)!.path}]`
      : "\n\n[output truncated]";
    return {
      ...result,
      content: `${full.slice(0, Math.max(0, this.maxOutputChars - suffix.length))}${suffix}`,
      truncated: true,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }
}

export const toolsPlugin = definePlugin<ToolsPluginConfig>({
  name: "tools",
  inject: ["hooks"],
  provides: ["tools"],
  apply(ctx: PluginContext, config: ToolsPluginConfig = {}) {
    const maxOutputChars = Math.max(1_000, config.maxOutputChars ?? 100_000);
    return ctx.effect(() => ctx.provide("tools", new ToolRegistryImpl(ctx, maxOutputChars)), "tools.provide");
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
