/**
 * Permission plugin: flavor-code's permission essence, mounted as a
 * `tools/before-call` waterfall listener — policy without loop changes.
 *
 * Modes:
 * - plan        read-only; writes/shell blocked
 * - default     reads auto-approved; writes/shell ask once per category
 * - acceptEdits reads+writes auto-approved; shell asks
 * - bypass      everything auto-approved except hard-dangerous commands
 *
 * Approvals persist for the process lifetime per (mode, category).
 * Asking delegates to the `interaction` capability; without it the engine
 * fails closed unless bypass.
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { HookBusService } from "../hooks";
import type { PromptAssemble } from "../prompt";
import { isWithinWorkspace, resolveToolPath } from "../tools/builtin/paths";
import type { BeforeToolCall, ToolCategory } from "../tools/registry";

export const PERMISSION_MODES = ["plan", "default", "acceptEdits", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Interaction capability: the host (CLI) provides it; SDK users may too. */
export interface InteractionService {
  ask(question: string): Promise<string | undefined>;
  confirm(question: string): Promise<boolean>;
}

export interface PermissionService {
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  /** Evaluate a tool call synchronously against mode + danger rules (no asking). */
  evaluateStatic(category: ToolCategory, args: Record<string, unknown>): { allow: boolean; reason?: string };
  /** Session-scoped approval memory, keyed by scope. */
  isApproved(key: string): boolean;
  approve(key: string): void;
}

/**
 * Hard-blocked command patterns — a slim version of flavor-code's destructive
 * list. These are rejected in every mode, including bypass.
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*f[a-z]*\s+)?(-[a-z]*r[a-z]*\s+)?["']?[\/~](?!\w)["']?/i, // rm -rf / or ~
  /\brm\s+-[a-z]*r[a-z]*\s+(-[a-z]*f[a-z]*\s+)?["']?[\/~]\\?["']?\s*$/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bformat\s+[a-z]:\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /:\(\)\{.*\};:/, // fork bomb
  /\breg\s+delete\b/i,
  /\brmdir\s+\/s\b/i,
];

const PATH_ARGUMENT_KEYS = ["path", "file", "file_path", "filePath", "target"];

class PermissionServiceImpl implements PermissionService {
  private current: PermissionMode;
  private approved = new Set<string>();

  constructor(initial: PermissionMode) {
    this.current = initial;
  }

  mode(): PermissionMode {
    return this.current;
  }

  setMode(mode: PermissionMode): void {
    this.current = mode;
    this.approved.clear(); // mode switch resets remembered approvals
  }

  isApproved(key: string): boolean {
    return this.approved.has(key);
  }

  approve(key: string): void {
    this.approved.add(key);
  }

  evaluateStatic(category: ToolCategory, args: Record<string, unknown>): { allow: boolean; reason?: string } {
    if (category === "shell") {
      const command = typeof args.command === "string" ? args.command : "";
      for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(command)) {
          return { allow: false, reason: `Blocked dangerous command pattern: ${pattern.source}` };
        }
      }
    }
    for (const key of PATH_ARGUMENT_KEYS) {
      const value = args[key];
      if (typeof value !== "string") continue;
      // Containment is validated with the call cwd when the hook runs; here we
      // only reject lexical traversal attempts ("..") which are never legit.
      if (value.split(/[\\/]/).includes("..")) {
        return { allow: false, reason: `Path argument "${key}" contains ".." traversal` };
      }
    }
    return { allow: true };
  }
}

/** Prompt section reflecting the live mode; re-read on every assemble. */
function permissionSection(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return [
        "- Permission mode is plan (read-only): write and shell tool calls are blocked.",
        "- Investigate and propose changes; do not attempt edits.",
      ].join("\n");
    case "bypass":
      return [
        "- Permission mode is bypass: tool calls run without approval.",
        "- Still avoid destructive or irreversible commands unless the user explicitly asks.",
      ].join("\n");
    default:
      return [
        `- Permission mode is ${mode}: some tool calls need user approval before they run.`,
        "- Prefer reversible actions; avoid destructive commands unless the user explicitly asks.",
      ].join("\n");
  }
}

export interface PermissionPluginConfig {
  mode?: PermissionMode;
}

function autoApprovedInMode(mode: PermissionMode, category: ToolCategory): boolean {
  switch (mode) {
    case "bypass":
      return true;
    case "acceptEdits":
      return category !== "shell";
    case "default":
      return category === "read" || category === "control";
    case "plan":
      return category === "read" || category === "control";
  }
}

function blockedInPlan(category: ToolCategory): boolean {
  return category === "write" || category === "shell";
}

export const permissionPlugin = definePlugin<PermissionPluginConfig>({
  name: "permission",
  inject: ["hooks", "tools"],
  provides: ["permission"],
  apply(ctx: PluginContext, config: PermissionPluginConfig = {}) {
    const service = new PermissionServiceImpl(config.mode ?? "default");
    return ctx.effect(() => {
      const hooks = ctx.get("hooks") as HookBusService;
      const disposeService = ctx.provide("permission", service);
      const disposeSection = hooks.hook<PromptAssemble>("prompt/assemble", async (event, next) => {
        event.sections.push({ name: "permissions", content: permissionSection(service.mode()) });
        return next(event);
      });
      const disposeHook = hooks.hook<BeforeToolCall>("tools/before-call", async (event, next) => {
        const category = event.tool?.category ?? "write";
        const mode = service.mode();

        const hard = service.evaluateStatic(category, event.args);
        if (!hard.allow) {
          event.block = true;
          event.reason = `${hard.reason} This action is not permitted in any mode.`;
          return event; // short-circuit: danger rules own the decision
        }

        if (mode === "plan" && blockedInPlan(category)) {
          event.block = true;
          event.reason = "Permission mode is plan (read-only). Switch with /permissions to make changes.";
          return event;
        }

        if (!autoApprovedInMode(mode, category)) {
          const approvalKey = `${mode}:${category}:${toolPathScope(ctx, event.args)}`;
          if (!service.isApproved(approvalKey)) {
            const interaction = ctx.tryGet("interaction") as InteractionService | undefined;
            if (!interaction) {
              event.block = true;
              event.reason = `${category} action requires approval and no interaction service is available.`;
              return event;
            }
            const approved = await interaction.confirm(
              `Allow ${event.toolCall.name} (${category})? [y = once, always via session approval]`,
            );
            if (!approved) {
              event.block = true;
              event.reason = "Denied by user.";
              return event;
            }
            service.approve(approvalKey);
          }
        }

        return next(event);
      });
      return () => {
        disposeHook();
        disposeSection();
        disposeService();
      };
    }, "permission.install");
  },
});

/** Approve per directory scope so one approval does not blanket the disk. */
function toolPathScope(ctx: PluginContext, args: Record<string, unknown>): string {
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      const absolute = resolveToolPath(ctx.cwd, value);
      if (!isWithinWorkspace(ctx.cwd, absolute)) return "__outside__";
      return absolute;
    }
  }
  return "__global__";
}

declare module "../../kernel/types" {
  interface ServiceMap {
    permission: PermissionService;
    interaction: InteractionService;
  }
}
