import { describe, expect, it } from "vitest";
import { sanitizeHistory, type Message } from "../src/shared/messages";

const tool = (id: string, content = `result ${id}`): Message => ({
  role: "tool",
  toolCallId: id,
  name: "Echo",
  content,
});

describe("sanitizeHistory", () => {
  it("keeps a fully answered tool-call group untouched", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "Echo", args: {} }] },
      tool("t1"),
      { role: "assistant", content: "done" },
    ];
    expect(sanitizeHistory(messages)).toEqual(messages);
  });

  it("strips a trailing assistant whose tool_calls were never answered", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "thinking", toolCalls: [{ id: "t1", name: "Echo", args: {} }] },
    ];
    expect(sanitizeHistory(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "thinking" },
    ]);
  });

  it("drops a partially answered group including the answered results", () => {
    const messages: Message[] = [
      { role: "assistant", content: "part", toolCalls: [
        { id: "t1", name: "Echo", args: {} },
        { id: "t2", name: "Echo", args: {} },
      ] },
      tool("t1"),
      // t2 missing (e.g. aborted mid-execution), then conversation continues
      { role: "user", content: "next" },
    ];
    expect(sanitizeHistory(messages)).toEqual([
      { role: "assistant", content: "part" },
      { role: "user", content: "next" },
    ]);
  });

  it("drops orphaned tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      tool("ghost"),
      { role: "assistant", content: "ok" },
    ];
    expect(sanitizeHistory(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("fills empty content when a dangling group had no text", () => {
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "Echo", args: {} }] },
      { role: "user", content: "next" },
    ];
    const sanitized = sanitizeHistory(messages);
    expect(sanitized[0]).toMatchObject({ role: "assistant" });
    expect((sanitized[0] as Extract<Message, { role: "assistant" }>).content.length).toBeGreaterThan(0);
  });
});
