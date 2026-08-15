/**
 * Compaction plugin: keeps the history under a token budget without loop
 * changes. Two hook points:
 * - `loop/before-request`: proactive trim when the footprint exceeds the
 *   budget (dropped middle is replaced by a summary marker, tail kept intact
 *   so tool_call/tool pairs never orphan)
 * - `loop/compact`: reactive fallback when the provider still reports
 *   context overflow
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import { messageFootprint, type Message } from "../../shared/messages";
import type { HookBusService } from "../hooks";
import type { BeforeLoopRequest, LoopCompact } from "../loop";

export interface CompactionPluginConfig {
  /** Soft budget in characters (~4 chars per token). Default 160k chars ≈ 40k tokens. */
  budget?: number;
  /** How many trailing messages must survive untouched. Default 20. */
  keepTail?: number;
}

const DEFAULT_BUDGET = 160_000;
const DEFAULT_KEEP_TAIL = 20;

function footprint(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageFootprint(message), 0);
}

/**
 * Trim the middle of the history. The cut boundary snaps backwards to a
 * safe point so an assistant tool_call message is never separated from its
 * tool results.
 */
export function compactMessages(messages: Message[], keepTail: number): Message[] {
  if (messages.length <= keepTail) return [...messages];
  const tail = messages.slice(messages.length - keepTail);
  const head = messages.slice(0, messages.length - keepTail);

  // Never start the tail mid tool-call sequence: pull the boundary back so
  // the first tail message is not a tool result.
  let boundary = head.length;
  while (boundary > 0 && messages[boundary]?.role === "tool") boundary -= 1;
  const keptHead = messages.slice(0, boundary);
  const keptTail = messages.slice(boundary);

  const dropped = footprint(head) - footprint(keptHead);
  const marker: Message = {
    role: "user",
    content:
      `[system] Earlier conversation (${keptHead.length} messages before this point) ` +
      `was compacted to fit the context window; roughly ${dropped} characters were dropped. ` +
      `Rely on the recent messages below and re-read files if details are needed.`,
  };
  return [...keptHead.slice(0, Math.max(2, Math.floor(keptHead.length / 4))), marker, ...keptTail];
}

export const compactionPlugin = definePlugin<CompactionPluginConfig>({
  name: "compaction",
  // The loop plugin provides "agent"; depending on it keeps hook registration ordered.
  inject: ["hooks", "agent"],
  apply(ctx: PluginContext, config: CompactionPluginConfig = {}) {
    const budget = config.budget ?? DEFAULT_BUDGET;
    const keepTail = config.keepTail ?? DEFAULT_KEEP_TAIL;

    return ctx.effect(() => {
      const hooks = ctx.get("hooks") as HookBusService;
      const disposeProactive = hooks.hook<BeforeLoopRequest>("loop/before-request", async (event, next) => {
        if (footprint(event.messages) > budget) {
          event.messages = compactMessages(event.messages, keepTail);
          ctx.logger.debug(`compaction trimmed history to ${footprint(event.messages)} chars`);
        }
        return next(event);
      });
      const disposeReactive = hooks.hook<LoopCompact>("loop/compact", async (event, next) => {
        event.messages = compactMessages(event.messages, Math.max(4, Math.floor(keepTail / 2)));
        return next(event);
      });
      return () => {
        disposeReactive();
        disposeProactive();
      };
    }, "compaction.install");
  },
});
