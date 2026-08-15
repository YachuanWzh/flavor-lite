import { describe, expect, it } from "vitest";
import { compactMessages } from "../src/plugins/compaction";
import type { Message } from "../src/shared/messages";

function message(role: Message["role"], index: number): Message {
  if (role === "tool") {
    return { role, toolCallId: `t${index}`, name: "Echo", content: `result ${index}` };
  }
  if (role === "assistant") {
    return { role, content: `assistant ${index}` };
  }
  return { role: "user", content: `user ${index}` };
}

describe("compaction", () => {
  it("returns the history untouched under the keep threshold", () => {
    const messages: Message[] = [message("user", 0), message("assistant", 1)];
    expect(compactMessages(messages, 20)).toEqual(messages);
  });

  it("keeps the tail intact and inserts a compaction marker", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) messages.push(message(i % 2 === 0 ? "user" : "assistant", i));
    const compacted = compactMessages(messages, 10);

    // Last ten messages survive verbatim.
    expect(compacted.slice(-10)).toEqual(messages.slice(-10));
    // A marker explains the gap.
    const marker = compacted.find(
      (entry) => entry.role === "user" && entry.content.startsWith("[system] Earlier conversation"),
    );
    expect(marker).toBeDefined();
    expect(compacted.length).toBeLessThan(messages.length);
  });

  it("never starts the kept tail with an orphaned tool result", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) messages.push(message("user", i));
    // Place a tool-call sequence so the naive keepTail boundary (index 20)
    // lands on an orphaned tool result.
    messages[18] = { role: "assistant", content: "calls", toolCalls: [{ id: "t19", name: "Echo", args: {} }] };
    messages[19] = message("tool", 19);
    messages[20] = message("tool", 20);
    messages[21] = message("tool", 21);

    const compacted = compactMessages(messages, 10);
    // Find the marker; everything after it must not start with a tool message.
    const markerIndex = compacted.findIndex(
      (entry) => entry.role === "user" && entry.content.startsWith("[system] Earlier conversation"),
    );
    expect(markerIndex).toBeGreaterThan(-1);
    const firstKept = compacted[markerIndex + 1];
    expect(firstKept).toBeDefined();
    expect(firstKept!.role).not.toBe("tool");
  });
});
