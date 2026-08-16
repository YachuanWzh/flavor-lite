import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { llmPlugin, type LlmService } from "../src/plugins/llm";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/plugins/llm/types";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";
import { promptPlugin } from "../src/plugins/prompt";
import { loopPlugin, type AgentEvent, type AgentService, type LoopAfterRun } from "../src/plugins/loop";
import { sessionPlugin, type SessionService } from "../src/plugins/session";
import type { Tool } from "../src/plugins/tools";

/**
 * A fake adapter replaying scripted event lists, capturing each request.
 * With repeatLast, calls beyond the script replay its final entry (useful
 * to simulate a model that keeps calling tools).
 */
function scriptedAdapter(script: ModelEvent[][], requests: ModelRequest[], repeatLast = false): ModelAdapter {
  let call = 0;
  return {
    type: "fake",
    async *stream(request: ModelRequest) {
      requests.push(request);
      const fallback: ModelEvent[] = [{ type: "done", stopReason: "end" as const }];
      const events =
        script[call] ?? (repeatLast && script.length > 0 ? script[script.length - 1]! : fallback);
      call += 1;
      for (const event of events) yield event;
    },
  };
}

const echoTool: Tool = {
  name: "Echo",
  description: "echo back the text argument",
  category: "read",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  async execute(args) {
    return { content: `echo: ${String(args.text ?? "")}` };
  },
};

const echoToolPlugin = definePlugin({
  name: "tool:echo",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => (ctx.get("tools") as ToolRegistry).register(echoTool), "tool:echo.register");
  },
});

describe("agent loop plugin", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-lite-test-"));
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function mount(script: ModelEvent[][], requests: ModelRequest[], withSession = false, repeatLast = false): Runtime {
    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(llmPlugin, {
        providers: { fake: { adapter: scriptedAdapter(script, requests, repeatLast), defaultModel: "fake-1" } },
      })
      .use(toolsPlugin)
      .use(echoToolPlugin)
      .use(promptPlugin)
      .use(loopPlugin);
    if (withSession) runtime.use(sessionPlugin);
    runtime.start();
    return runtime;
  }

  it("runs a tool-call turn then a final text turn and logs every message", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [
          { type: "text_delta", text: "let me check" },
          { type: "tool_call", toolCall: { id: "t1", name: "Echo", args: { text: "hi" } } },
          { type: "usage", inputTokens: 10, outputTokens: 5 },
          { type: "done", stopReason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "all done" }, { type: "done", stopReason: "end" }],
      ],
      requests,
      true,
    );

    const agent = rt.ctx.get("agent") as AgentService;
    const events: AgentEvent[] = [];
    for await (const event of agent.run({ input: "say hi" })) events.push(event);

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "text_delta",
      "usage",
      "message_end",
      "tool_start",
      "tool_end",
      "turn_start",
      "text_delta",
      "message_end",
      "agent_end",
    ]);
    const end = events.find((event) => event.type === "agent_end");
    expect(end).toMatchObject({ reason: "finished", iterations: 2 });

    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd).toMatchObject({ content: "echo: hi", isError: false });

    // Second request must carry the full model-visible history (logged ⇔ visible).
    const second = requests[1];
    expect(second).toBeDefined();
    expect(second!.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);

    // And the session file mirrors it: model-visible ⇔ logged.
    const sessions = rt.ctx.get("session") as SessionService;
    const latestId = await sessions.latest();
    expect(latestId).toBeDefined();
    const handle = await sessions.open(latestId!);
    expect(handle.messages().map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("injects steering messages before the next model request", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [
          { type: "tool_call", toolCall: { id: "t1", name: "Echo", args: { text: "a" } } },
          { type: "done", stopReason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "ok" }, { type: "done", stopReason: "end" }],
      ],
      requests,
    );
    const agent = rt.ctx.get("agent") as AgentService;
    agent.steer("be brief");
    for await (const _ of agent.run({ input: "work" })) {
      /* drain */
    }
    const second = requests[1];
    expect(second).toBeDefined();
    const steering = second!.messages.find(
      (message) => message.role === "user" && message.content.includes("[steering] be brief"),
    );
    expect(steering).toBeDefined();
  });

  it("stops at maxIterations when the model keeps calling tools", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [
          { type: "tool_call", toolCall: { id: "t1", name: "Echo", args: { text: "loop" } } },
          { type: "done", stopReason: "tool_calls" },
        ],
      ],
      requests,
      false,
      true, // model keeps calling the same tool forever
    );
    const agent = rt.ctx.get("agent") as AgentService;
    const events: AgentEvent[] = [];
    for await (const event of agent.run({ input: "spin", maxIterations: 2 })) events.push(event);
    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings.length).toBeGreaterThan(0); // 80% warning fires at iteration 2
    const end = events.find((event) => event.type === "agent_end");
    expect(end).toMatchObject({ reason: "max_iterations", iterations: 2 });
  });

  it("records placeholder results for aborted tool calls so the session stays wire-valid", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [
          { type: "tool_call", toolCall: { id: "t1", name: "Echo", args: { text: "a" } } },
          { type: "tool_call", toolCall: { id: "t2", name: "Echo", args: { text: "b" } } },
          { type: "done", stopReason: "tool_calls" },
        ],
      ],
      requests,
      true,
    );
    const aborter = new AbortController();
    const agent = rt.ctx.get("agent") as AgentService;
    let sessionId: string | undefined;
    for await (const event of agent.run({ input: "work", signal: aborter.signal })) {
      if (event.type === "agent_start") sessionId = event.sessionId;
      if (event.type === "tool_end") aborter.abort(); // abort after the first result
    }

    const sessions = rt.ctx.get("session") as SessionService;
    const handle = await sessions.open(sessionId!);
    const messages = handle.messages();
    // user, assistant(tool_calls), executed t1, placeholder for t2
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
    const placeholder = messages[3]!;
    expect(placeholder).toMatchObject({ role: "tool", toolCallId: "t2", isError: true });
    expect(placeholder.content).toMatch(/aborted/i);
  });

  describe("loop/after-run hook", () => {
    function collectAfterRun(rt: Runtime): LoopAfterRun[] {
      const seen: LoopAfterRun[] = [];
      (rt.ctx.get("hooks") as HookBusService).hook("loop/after-run", async (event, next) => {
        seen.push(event);
        return next(event);
      });
      return seen;
    }

    it("fires once with reason finished on a normal run", async () => {
      const requests: ModelRequest[] = [];
      const rt = mount(
        [[{ type: "text_delta", text: "done" }, { type: "done", stopReason: "end" }]],
        requests,
      );
      const seen = collectAfterRun(rt);
      const agent = rt.ctx.get("agent") as AgentService;
      for await (const _ of agent.run({ input: "hi" })) {
        /* drain */
      }
      expect(seen).toEqual([{ iterations: 1, reason: "finished" }]);
    });

    it("fires with reason aborted before agent_end when the signal is already aborted", async () => {
      const requests: ModelRequest[] = [];
      const rt = mount([], requests);
      const seen = collectAfterRun(rt);
      const aborter = new AbortController();
      aborter.abort();
      const agent = rt.ctx.get("agent") as AgentService;
      const events: AgentEvent[] = [];
      for await (const event of agent.run({ input: "hi", signal: aborter.signal })) events.push(event);
      expect(seen).toEqual([{ iterations: 0, reason: "aborted" }]);
      expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "aborted" });
    });

    it("fires with reason max_iterations when the model keeps calling tools", async () => {
      const requests: ModelRequest[] = [];
      const rt = mount(
        [
          [
            { type: "tool_call", toolCall: { id: "t1", name: "Echo", args: { text: "spin" } } },
            { type: "done", stopReason: "tool_calls" },
          ],
        ],
        requests,
        false,
        true, // model repeats the same tool call forever
      );
      const seen = collectAfterRun(rt);
      const agent = rt.ctx.get("agent") as AgentService;
      for await (const _ of agent.run({ input: "spin", maxIterations: 2 })) {
        /* drain */
      }
      expect(seen).toEqual([{ iterations: 2, reason: "max_iterations" }]);
    });

    it("survives a throwing after-run listener: the run still ends cleanly", async () => {
      const requests: ModelRequest[] = [];
      const rt = mount(
        [[{ type: "text_delta", text: "done" }, { type: "done", stopReason: "end" }]],
        requests,
      );
      (rt.ctx.get("hooks") as HookBusService).hook("loop/after-run", async () => {
        throw new Error("lifecycle listener blew up");
      });
      const agent = rt.ctx.get("agent") as AgentService;
      const events: AgentEvent[] = [];
      for await (const event of agent.run({ input: "hi" })) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "finished" });
    });
  });

  it("resolves model refs through the llm service", () => {
    const requests: ModelRequest[] = [];
    const rt = mount([], requests);
    const llm = rt.ctx.get("llm") as LlmService;
    expect(llm.resolve()).toEqual({ provider: "fake", model: "fake-1" });
    expect(llm.defaultRef()).toBe("fake:fake-1");
    expect(() => llm.setDefaultRef("nope:model")).toThrow(/unknown provider/);
  });
});
