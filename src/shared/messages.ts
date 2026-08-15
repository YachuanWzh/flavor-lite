/**
 * Provider-neutral message model shared by llm, session, loop, and compaction.
 * Sessions log exactly these shapes — model-visible ⇔ logged.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; raw string is kept when parsing fails. */
  args: Record<string, unknown>;
  rawArgs?: string;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export function messageText(message: Message): string {
  return message.content;
}

/** Rough serialized size used by token budgeting. */
export function messageFootprint(message: Message): number {
  let chars = message.content.length;
  if (message.role === "assistant" && message.toolCalls) {
    chars += JSON.stringify(message.toolCalls).length;
  }
  return chars;
}
