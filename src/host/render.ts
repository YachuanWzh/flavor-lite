/**
 * Event rendering for the terminal host. Zero-dependency ANSI coloring that
 * degrades to plain text when stdout is not a TTY or NO_COLOR is set.
 */

import type { AgentEvent } from "../plugins/loop";
import type { ToolCall } from "../shared/messages";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function wrap(code: number): (text: string) => string {
  return (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
}

export const dim = wrap(2);
export const bold = wrap(1);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);
export const green = wrap(32);

/** A plugin that failed to load, shown in the banner. */
export interface UiPluginError {
  name: string;
  error: string;
}

/** Data the host hands to a UI plugin's banner renderer. */
export interface UiBannerInfo {
  /** flavor-lite version, e.g. "0.1.1". */
  version?: string;
  model: string;
  mode: string;
  sessionId: string;
  plugins: {
    loaded: number;
    total: number;
    errors: UiPluginError[];
  };
}

/**
 * Render seam for UI plugins. The host resolves the optional "ui" service
 * once per turn and delegates event rendering to it when present, falling
 * back to `renderEvent` otherwise. All methods are optional so a plugin may
 * implement only the parts it cares about.
 */
export interface UiService {
  /** Render one agent event. */
  render(event: AgentEvent): void;
  /** Render the echoed user input at the start of a turn. */
  renderUserInput?(input: string): void;
  /** Render the startup banner (model/mode/session/plugin status). */
  renderBanner?(info: UiBannerInfo): void;
  /** Render a caught turn-level error (model failure, aborted stream). */
  renderError?(error: Error): void;
  /** Render a non-fatal notice. */
  renderNotice?(message: string): void;
  /** Pause in-place animations while the host owns the terminal (prompts). */
  pauseAnimation?(): void;
}

declare module "../kernel/types" {
  interface ServiceMap {
    ui: UiService;
  }
}

function toolCallSummary(toolCall: ToolCall): string {
  const primary = toolCall.args.path ?? toolCall.args.file_path ?? toolCall.args.command ?? toolCall.args.pattern ?? toolCall.args.query;
  if (typeof primary !== "string") return "";
  return primary.length > 90 ? `${primary.slice(0, 87)}...` : primary;
}

/** Render one agent event to stdout. Returns a usage string on agent_end. */
export function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      break; // the REPL prints its own header
    case "turn_start":
      break;
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "message_end":
      process.stdout.write("\n");
      break;
    case "tool_start":
      process.stdout.write(dim(`  ⚙ ${event.toolCall.name} ${toolCallSummary(event.toolCall)}`) + "\n");
      break;
    case "tool_end":
      if (event.isError) {
        process.stdout.write(red(`  ✗ ${event.toolCall.name} failed: ${firstLine(event.content, 160)}`) + "\n");
      }
      break;
    case "usage":
      process.stdout.write(dim(`  tokens: ${event.inputTokens} in / ${event.outputTokens} out`) + "\n");
      break;
    case "warning":
      process.stdout.write(yellow(`⚠ ${event.message}`) + "\n");
      break;
    case "agent_end":
      if (event.reason === "max_iterations") {
        process.stdout.write(yellow(`Stopped at the iteration limit (${event.iterations} turns).`) + "\n");
      } else if (event.reason === "aborted") {
        process.stdout.write(dim("Aborted.") + "\n");
      }
      break;
  }
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
