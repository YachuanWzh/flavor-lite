import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { toolsPlugin, type Tool, type ToolRegistry } from "../src/plugins/tools";
import { permissionPlugin } from "../src/plugins/permission";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { telemetryPlugin, type TelemetryService } from "../src/plugins/telemetry";
import type { LoopAfterRun } from "../src/plugins/loop";

const readTool: Tool = {
  name: "FakeRead",
  description: "pretends to read",
  category: "read",
  inputSchema: { type: "object" },
  async execute() {
    return { content: "read ok" };
  },
};

const writeTool: Tool = {
  name: "FakeWrite",
  description: "pretends to write",
  category: "write",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  async execute() {
    return { content: "written" };
  },
};

const testToolsPlugin = definePlugin({
  name: "tool:fake",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => {
      const registry = ctx.get("tools") as ToolRegistry;
      const d1 = registry.register(readTool);
      const d2 = registry.register(writeTool);
      return () => {
        d2();
        d1();
      };
    }, "tool:fake.register");
  },
});

describe("telemetry plugin", () => {
  let tmp: string;
  let runtime: Runtime;

  function mount(mode: "default" | "plan" = "default", config: Record<string, unknown> = {}): void {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(testToolsPlugin)
      .use(permissionPlugin, { mode })
      .use(commandsPlugin)
      .use(telemetryPlugin, config);
    runtime.start();
  }

  function telemetry(): TelemetryService {
    return runtime.ctx.get("telemetry") as TelemetryService;
  }

  async function call(name: string, args: Record<string, unknown>) {
    const registry = runtime.ctx.get("tools") as ToolRegistry;
    return registry.execute({ id: "c1", name, args }, { cwd: runtime.ctx.cwd });
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flavor-telemetry-"));
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(tmp, { recursive: true, force: true });
  });

  it("records events with timestamps and reads them back in order", async () => {
    mount();
    telemetry().record({ type: "custom.a", n: 1 });
    telemetry().record({ type: "custom.b", n: 2 });
    const events = await telemetry().events();
    expect(events.map((event) => event.type)).toEqual(["custom.a", "custom.b"]);
    expect(events[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0]!.schemaVersion).toBe(1);
    expect(events[0]!.eventId).toBeTruthy();
    expect(events[1]!.n).toBe(2);
    // The feed is plain JSONL on disk.
    const raw = await readFile(join(tmp, ".flavorlite", "telemetry.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("filters events by type and limit", async () => {
    mount();
    for (let index = 0; index < 5; index += 1) telemetry().record({ type: "tick", index });
    telemetry().record({ type: "other" });
    const ticks = await telemetry().events({ type: "tick" });
    expect(ticks).toHaveLength(5);
    const lastTwo = await telemetry().events({ type: "tick", limit: 2 });
    expect(lastTwo.map((event) => event.index)).toEqual([3, 4]);
  });

  it("captures tool.call events through the tools/after-call hook", async () => {
    mount();
    const result = await call("FakeRead", {});
    expect(result.isError).toBeUndefined();
    const events = await telemetry().events({ type: "tool.call" });
    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe("FakeRead");
    expect(events[0]!.isError).toBe(false);
  });

  it("captures tool.blocked even when permission short-circuits the chain", async () => {
    mount("plan"); // plan blocks writes and returns without calling next()
    const result = await call("FakeWrite", { path: "a.txt" });
    expect(result.isError).toBe(true);
    const blocked = await telemetry().events({ type: "tool.blocked" });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.tool).toBe("FakeWrite");
    expect(String(blocked[0]!.reason)).toMatch(/plan/);
    // A blocked call never executes, so no tool.call event is recorded.
    expect(await telemetry().events({ type: "tool.call" })).toHaveLength(0);
  });

  it("captures run.end from the loop/after-run waterfall", async () => {
    mount();
    const hooks = runtime.ctx.get("hooks") as HookBusService;
    const payload: LoopAfterRun = {
      iterations: 3,
      reason: "finished",
      toolCalls: 4,
      toolErrors: 1,
      steers: 0,
      inputTokens: 100,
      outputTokens: 50,
    };
    await hooks.waterfall<LoopAfterRun>("loop/after-run", payload);
    const events = await telemetry().events({ type: "run.end" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "finished", toolCalls: 4, toolErrors: 1, outputTokens: 50 });
  });

  it("/telemetry stats summarizes the feed", async () => {
    mount();
    await call("FakeRead", {});
    const hooks = runtime.ctx.get("hooks") as HookBusService;
    await hooks.waterfall<LoopAfterRun>("loop/after-run", {
      iterations: 1,
      reason: "finished",
      toolCalls: 1,
      toolErrors: 0,
      steers: 0,
      inputTokens: 10,
      outputTokens: 5,
    });
    const commands = runtime.ctx.get("commands") as CommandsService;
    const stats = await commands.execute("/telemetry stats");
    expect(stats).toContain("runs: 1 (1 finished)");
    expect(stats).toContain("tool calls: 1 (0 failed)");
    expect(stats).toContain("FakeRead");
  });

  it("respects enabled: false (record becomes a no-op)", async () => {
    mount("default", { enabled: false });
    telemetry().record({ type: "custom.a" });
    expect(await telemetry().events()).toHaveLength(0);
  });

  it("clear() empties the feed", async () => {
    mount();
    telemetry().record({ type: "custom.a" });
    await telemetry().clear();
    expect(await telemetry().events()).toHaveLength(0);
  });

  it("redacts secret fields and reduces events into a stable projection", async () => {
    mount();
    telemetry().record({ type: "custom.secret", token: "do-not-store", inputTokens: 42 });
    telemetry().record({ type: "router.recall", plugins: ["demo"] });
    telemetry().record({ type: "router.feedback", entries: [{ plugin: "demo", used: true }] });
    const events = await telemetry().events();
    expect(events[0]!.token).toBe("[redacted]");
    expect(events[0]!.inputTokens).toBe(42);
    const projection = await telemetry().reduce();
    expect(projection.perPlugin.demo).toEqual({ recalls: 1, used: 1, unused: 0 });
  });
});
