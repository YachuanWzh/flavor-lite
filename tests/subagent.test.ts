import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin } from "../src/plugins/hooks";
import { llmPlugin } from "../src/plugins/llm";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/plugins/llm/types";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";
import { promptPlugin, type PromptService } from "../src/plugins/prompt";
import { loopPlugin, type AgentEvent, type AgentService } from "../src/plugins/loop";
import { sessionPlugin, type SessionService } from "../src/plugins/session";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";

/**
 * The plugin under test is loaded the way a user loads it: through the
 * plugins loader, from the real .flavorlite/plugins/subagent/ directory.
 */
const PLUGINS_ROOT = fileURLToPath(new URL("../.flavorlite/plugins", import.meta.url));

/** Fake adapter replaying scripted events; calls beyond the script fall back to a bare "done". */
function scriptedAdapter(script: ModelEvent[][], requests: ModelRequest[]): ModelAdapter {
  let call = 0;
  return {
    type: "fake",
    async *stream(request: ModelRequest) {
      requests.push(request);
      const fallback: ModelEvent[] = [{ type: "done", stopReason: "end" as const }];
      const events = script[call] ?? fallback;
      call += 1;
      for (const event of events) yield event;
    },
  };
}

function spawnCall(id: string, task: string, role?: string): ModelEvent {
  return {
    type: "tool_call",
    toolCall: { id, name: "subagent_spawn", args: { task, ...(role ? { role } : {}) } },
  };
}

function textTurn(text: string): ModelEvent[] {
  return [{ type: "text_delta", text }, { type: "done", stopReason: "end" }];
}

describe("subagent plugin", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-subagent-test-"));
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function mount(script: ModelEvent[][], requests: ModelRequest[]): Runtime {
    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(llmPlugin, {
        providers: { fake: { adapter: scriptedAdapter(script, requests), defaultModel: "fake-1" } },
      })
      .use(toolsPlugin)
      .use(promptPlugin)
      .use(loopPlugin)
      .use(sessionPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [PLUGINS_ROOT] });
    runtime.start();
    return runtime;
  }

  it("loads through the plugins loader", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount([], requests);
    const loader = rt.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();

    const status = loader.list().find((entry) => entry.name === "subagent");
    expect(status?.status).toBe("loaded");

    // The spawn tool is registered and the guidance section is assembled.
    const tools = rt.ctx.get("tools") as ToolRegistry;
    expect(tools.list().some((tool) => tool.name === "subagent_spawn")).toBe(true);
    const prompt = await (rt.ctx.get("systemPrompt") as PromptService).assemble();
    expect(prompt).toContain("subagent_spawn");
    expect(prompt).toContain("3 levels of nesting");
  });

  it("spawns a child with its own prompt section and session, returning only the report", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [spawnCall("s1", "summarize the docs", "a docs reviewer"), { type: "done", stopReason: "tool_calls" }],
        textTurn("child report: everything is fine"),
        textTurn("parent done"),
      ],
      requests,
    );
    const loader = rt.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();

    const agent = rt.ctx.get("agent") as AgentService;
    const events: AgentEvent[] = [];
    for await (const event of agent.run({ input: "delegate the summary" })) events.push(event);

    // 3 model requests: parent (spawn) → child (report) → parent (done).
    expect(requests).toHaveLength(3);

    // The child request carries its own system-prompt section: task, role, depth.
    const child = requests[1]!;
    expect(child.systemPrompt).toContain("Assigned task: summarize the docs");
    expect(child.systemPrompt).toContain("Role: a docs reviewer");
    expect(child.systemPrompt).toContain("nesting depth 1 of 3");

    // The parent sees only the child's final report as the tool result.
    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd).toMatchObject({ isError: false });
    expect(toolEnd!.content).toContain("child report: everything is fine");
    expect(toolEnd!.content).toContain("[subagent report — depth 1/3");
    expect(events.find((event) => event.type === "agent_end")).toMatchObject({ reason: "finished" });

    // Two sessions: the root one (which never saw child messages) and the child's own.
    const sessions = rt.ctx.get("session") as SessionService;
    const infos = await sessions.list();
    expect(infos).toHaveLength(2);
    const childInfo = infos.find((info) => info.title?.startsWith("subagent (depth 1)"));
    expect(childInfo).toBeDefined();
    const childHandle = await sessions.open(childInfo!.id);
    expect(childHandle.messages().map((message) => message.role)).toEqual(["user", "assistant"]);

    const rootHandle = await sessions.open(infos.find((info) => info !== childInfo)!.id);
    const rootRoles = rootHandle.messages().map((message) => message.role);
    expect(rootRoles.filter((role) => role !== "tool")).toEqual(["user", "assistant", "assistant"]);
  });

  it("rejects spawning beyond 3 levels and records the error in the depth-3 session", async () => {
    const requests: ModelRequest[] = [];
    const rt = mount(
      [
        [spawnCall("a", "t1"), { type: "done", stopReason: "tool_calls" }], // root → depth 1
        [spawnCall("b", "t2"), { type: "done", stopReason: "tool_calls" }], // depth 1 → 2
        [spawnCall("c", "t3"), { type: "done", stopReason: "tool_calls" }], // depth 2 → 3
        [spawnCall("d", "t4"), { type: "done", stopReason: "tool_calls" }], // depth 3 → 4: blocked
        textTurn("blocked at depth 4"),
        textTurn("got t3 report"),
        textTurn("got t2 report"),
        textTurn("got t1 report"),
      ],
      requests,
    );
    const loader = rt.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();

    const agent = rt.ctx.get("agent") as AgentService;
    const events: AgentEvent[] = [];
    for await (const event of agent.run({ input: "go deep" })) events.push(event);

    // 8 requests exactly: the depth-4 spawn produced no extra model request.
    expect(requests).toHaveLength(8);

    // Each child saw the correct depth in its system prompt.
    expect(requests[1]!.systemPrompt).toContain("nesting depth 1 of 3");
    expect(requests[2]!.systemPrompt).toContain("nesting depth 2 of 3");
    expect(requests[3]!.systemPrompt).toContain("nesting depth 3 of 3");

    // The rejected spawn is recorded as an error tool result in the depth-3
    // session, and created no orphan session of its own.
    const sessions = rt.ctx.get("session") as SessionService;
    const infos = await sessions.list();
    expect(infos).toHaveLength(4); // root + 3 children, no depth-4 session
    const d3 = infos.find((info) => info.title?.startsWith("subagent (depth 3)"));
    expect(d3).toBeDefined();
    const d3Handle = await sessions.open(d3!.id);
    const rejected = d3Handle.messages().find((message) => message.role === "tool");
    expect(rejected).toBeDefined();
    expect(rejected!.isError).toBe(true);
    expect(rejected!.content).toMatch(/maximum nesting depth is 3/);

    // The whole chain still completes: the root's spawn result is the depth-1
    // child's report, which summarizes the depth-2 child's report.
    const toolEnds = events.filter((event) => event.type === "tool_end");
    expect(toolEnds[toolEnds.length - 1]!.content).toContain("got t2 report");
  });
});
