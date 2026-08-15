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

/**
 * Repair history so providers never see a dangling tool-call group:
 * - an assistant message whose tool_calls are not all answered by following
 *   tool messages is rewritten as plain text (partial results dropped too)
 * - orphaned tool results (no matching pending call) are dropped
 * This guards against mid-turn aborts, torn session files, and compaction
 * boundaries that cut through a tool-call sequence.
 */
export function sanitizeHistory(messages: Message[]): Message[] {
  const output: Message[] = [];
  let pending: { index: number; ids: Set<string> } | undefined;

  const settlePending = (): void => {
    if (!pending) return;
    const { index } = pending;
    pending = undefined;
    const assistant = output[index];
    // Drop the assistant's (partial) tool group, keep it as plain text.
    output.length = index;
    if (assistant && assistant.role === "assistant") {
      output.push({
        role: "assistant",
        content: assistant.content || "(an earlier tool call was not executed)",
      });
    }
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      settlePending();
      output.push(message);
      pending = { index: output.length - 1, ids: new Set(message.toolCalls.map((call) => call.id)) };
      continue;
    }
    if (message.role === "tool") {
      if (pending && pending.ids.has(message.toolCallId)) {
        pending.ids.delete(message.toolCallId);
        output.push(message);
        if (pending.ids.size === 0) pending = undefined;
      }
      // Orphaned tool result: silently dropped.
      continue;
    }
    settlePending();
    output.push(message);
  }
  settlePending();
  return output;
}
