import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin } from "../src/plugins/hooks";
import { toolsPlugin } from "../src/plugins/tools";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { ToolRegistry } from "../src/plugins/tools/registry";

/**
 * The task-planner plugin under test is loaded the way a user loads it:
 * through the plugins loader from the real .flavorlite/plugins/task-planner/
 * directory, copied into an isolated temp root.
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/task-planner", import.meta.url));

async function copyDir(source: string, targetRoot: string): Promise<string> {
  const name = source.split(/[\\/]/).pop() as string;
  const target = join(targetRoot, name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    await writeFile(join(target, file), await readFile(join(source, file), "utf-8"));
  }
  return target;
}

async function readPlans(dir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(join(dir, ".flavorlite", "task-planner", "plans.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe("task-planner plugin", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-planner-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
    // task-planner is activation=dynamic: mount it the way router recall would.
    await loader.ensure("task-planner");
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function tools(): ToolRegistry {
    return runtime.ctx.get("tools") as ToolRegistry;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const tool = tools().get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute(args, { cwd: dir });
  }

  function commands(): CommandsService {
    return runtime.ctx.get("commands") as CommandsService;
  }

  async function startPlan(goal: string): Promise<void> {
    const result = await callTool("plan_start", {
      goal,
      tasks: [
        { content: "step one", detail: "verify one" },
        { content: "step two" },
      ],
    });
    expect(result.isError).not.toBe(true);
  }

  it("loads and registers the plan tools and /plan-log", async () => {
    const status = loader.list().find((entry) => entry.name === "task-planner");
    if (status?.status !== "loaded") {
      throw new Error(`task-planner failed to load: ${status?.error ?? "no status"}`);
    }
    expect(tools().get("plan_start")).toBeTruthy();
    expect(tools().get("plan_end")).toBeTruthy();
    expect(await commands().execute("/plan-log")).toContain("no archived plans");
  });

  it("plan_end archives the plan with final task states and clears memory", async () => {
    await startPlan("ship the feature");
    await callTool("plan_update", { index: 1, status: "done" });
    await callTool("plan_update", { index: 2, status: "error" });

    const ended = await callTool("plan_end", { outcome: "partial" });
    expect(ended.isError).not.toBe(true);

    const plans = await readPlans(dir);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      goal: "ship the feature",
      outcome: "partial",
      tasks: [
        { content: "step one", detail: "verify one", status: "done" },
        { content: "step two", status: "error" },
      ],
    });
    expect(typeof plans[0]!.startedAt).toBe("string");
    expect(typeof plans[0]!.endedAt).toBe("string");

    // Memory cleared: board gone, updates rejected.
    expect(String((await callTool("plan_view", {})).content)).toContain("No active plan");
    const update = await callTool("plan_update", { index: 1, status: "done" });
    expect(update.isError).toBe(true);
  });

  it("plan_end without an active plan is an error", async () => {
    const result = await callTool("plan_end", { outcome: "success" });
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown outcome value", async () => {
    await startPlan("goal");
    const result = await callTool("plan_end", { outcome: "exploded" });
    expect(result.isError).toBe(true);
    // Plan stays active after a rejected archive.
    expect(String((await callTool("plan_view", {})).content)).toContain("Task Plan");
  });

  it("appends one record per archived plan", async () => {
    await startPlan("first job");
    await callTool("plan_end", { outcome: "success" });
    await startPlan("second job");
    await callTool("plan_end", { outcome: "failed" });

    const plans = await readPlans(dir);
    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.goal)).toEqual(["first job", "second job"]);
  });

  it("/plan-log lists archived plans with goal and outcome", async () => {
    await startPlan("first job");
    await callTool("plan_end", { outcome: "success" });

    const log = await commands().execute("/plan-log");
    expect(log).toContain("first job");
    expect(log).toContain("success");
  });
});
