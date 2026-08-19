import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { toolsPlugin } from "../src/plugins/tools";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin, type PromptAssemble } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { AfterToolCall, ToolRegistry } from "../src/plugins/tools/registry";
import type { LoopAfterRun } from "../src/plugins/loop";

/**
 * The evolve plugin under test is loaded the way a user loads it: through the
 * plugins loader from the real .flavorlite/plugins/evolve/ directory, copied
 * into an isolated temp root.
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/evolve", import.meta.url));

async function copyDir(source: string, targetRoot: string): Promise<string> {
  const name = source.split(/[\\/]/).pop() as string;
  const target = join(targetRoot, name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    await writeFile(join(target, file), await readFile(join(source, file), "utf-8"));
  }
  return target;
}

function shellCall(command: string, id = "call_1"): AfterToolCall["toolCall"] {
  return { id, name: "Shell", args: { command } };
}

async function readSignals(dir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(join(dir, ".flavorlite", "evolve", "signals.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readReflections(dir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(join(dir, ".flavorlite", "evolve", "reflections.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readPatterns(dir: string): Promise<Array<Record<string, unknown> & { sequence: string[] }>> {
  try {
    const text = await readFile(join(dir, ".flavorlite", "evolve", "patterns.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readRulesFile(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, ".flavorlite", "evolve", "rules.md"), "utf-8");
  } catch {
    return "";
  }
}

describe("evolve plugin", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-evolve-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function hooks(): HookBusService {
    return runtime.ctx.get("hooks") as HookBusService;
  }

  function commands(): CommandsService {
    return runtime.ctx.get("commands") as CommandsService;
  }

  async function fireError(toolCall: AfterToolCall["toolCall"], result: AfterToolCall["result"]): Promise<void> {
    await hooks().waterfall<AfterToolCall>("tools/after-call", { toolCall, args: toolCall.args, result });
  }

  function tools(): ToolRegistry {
    return runtime.ctx.get("tools") as ToolRegistry;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const tool = tools().get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute(args, { cwd: dir });
  }

  async function fireOk(name: string, id = "call_ok"): Promise<void> {
    await hooks().waterfall<AfterToolCall>("tools/after-call", {
      toolCall: { id, name, args: {} },
      args: {},
      result: { content: "ok", isError: false },
    });
  }

  const runStats: LoopAfterRun = {
    iterations: 3,
    reason: "finished",
    toolCalls: 5,
    toolErrors: 0,
    steers: 0,
    inputTokens: 10,
    outputTokens: 5,
  };

  /** One simulated run: a sequence of successful tool calls, then after-run. */
  async function runOnceWithSequence(names: string[]): Promise<void> {
    for (const name of names) await fireOk(name);
    await hooks().waterfall<LoopAfterRun>("loop/after-run", runStats);
  }

  /** Raise one failure signal to threshold (2) and return its suggestion id. */
  async function raiseSuggestion(command: string): Promise<string> {
    await fireError(shellCall(command), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall(command), { content: "boom [exit code: 1]", isError: true });
    const listing = (await commands().execute("/evolve suggest")) ?? "";
    const id = listing.match(/\[([0-9a-f]{12})\]/)?.[1];
    if (!id) throw new Error(`no suggestion id found in: ${listing}`);
    return id;
  }

  it("loads and registers /evolve", async () => {
    const status = loader.list().find((entry) => entry.name === "evolve");
    if (status?.status !== "loaded") {
      throw new Error(`evolve failed to load: ${status?.error ?? "no status"}`);
    }
    expect(status?.status).toBe("loaded");
    expect(await commands().execute("/evolve")).toContain("usage");
  });

  it("records a failing tool result as a signal", async () => {
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });

    const signals = await readSignals(dir);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.tool).toBe("Shell");
    expect(signals[0]!.count).toBe(1);
  });

  it("deduplicates identical failures (count bumps, no new record)", async () => {
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });

    const signals = await readSignals(dir);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.count).toBe(3);
  });

  it("records distinct failures separately", async () => {
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall("frobnicate"), { content: "different failure", isError: true });

    const signals = await readSignals(dir);
    expect(signals).toHaveLength(2);
  });

  it("ignores successful tool results", async () => {
    await fireError(shellCall("dir"), { content: "ok", isError: false });

    const signals = await readSignals(dir);
    expect(signals).toHaveLength(0);
  });

  it("surfaces a suggestion only after >= 2 repeats (threshold)", async () => {
    expect(await commands().execute("/evolve suggest")).toContain("no open suggestions");

    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    expect(await commands().execute("/evolve suggest")).toContain("no open suggestions");

    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    const suggest = await commands().execute("/evolve suggest");
    expect(suggest).toContain("Shell");
    expect(suggest).toContain("x2");
  });

  it("records run stats and a real signalDelta in reflections", async () => {
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });

    const stats: LoopAfterRun = {
      iterations: 3,
      reason: "finished",
      toolCalls: 5,
      toolErrors: 2,
      steers: 1,
      inputTokens: 100,
      outputTokens: 50,
    };
    await hooks().waterfall<LoopAfterRun>("loop/after-run", stats);

    let reflections = await readReflections(dir);
    expect(reflections).toHaveLength(1);
    expect(reflections[0]).toMatchObject({
      iterations: 3,
      reason: "finished",
      toolCalls: 5,
      toolErrors: 2,
      steers: 1,
      totalFailures: 2,
      signalDelta: 0, // no previous reflection: baseline
      failedTools: ["Shell"],
    });

    // Same failures again (count bumps 2 -> 4), then a second run.
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await fireError(shellCall("frobnicate"), { content: "boom [exit code: 1]", isError: true });
    await hooks().waterfall<LoopAfterRun>("loop/after-run", stats);

    reflections = await readReflections(dir);
    expect(reflections).toHaveLength(2);
    expect(reflections[1]).toMatchObject({ totalFailures: 4, signalDelta: 2 });
  });

  it("/evolve verify sandbox-dry-runs a scaffolded fix plugin", async () => {
    const scaffoldDir = await loader.scaffold("fix-shell");
    expect(scaffoldDir).toContain("fix-shell");

    const report = await commands().execute("/evolve verify fix-shell");
    expect(report).toContain("verify OK");
    expect(report).toContain("fix-shell_hello"); // tool the template registers

    const unknown = await commands().execute("/evolve verify ghost");
    expect(unknown).toContain("verify FAILED");
  });

  it("evolve_improve kind=prompt_rule appends a rule, closes the suggestion, scaffolds nothing", async () => {
    const id = await raiseSuggestion("frobnicate");

    const improve = tools().get("evolve_improve");
    expect(improve).toBeTruthy();
    const result = await callTool("evolve_improve", {
      suggestionId: id,
      implementation: "Always quote Windows paths passed to Shell commands.",
      kind: "prompt_rule",
    });
    expect(result.isError).not.toBe(true);

    const rules = await readRulesFile(dir);
    expect(rules).toContain("Always quote Windows paths passed to Shell commands.");

    // Suggestion closed: nothing open remains.
    expect(await commands().execute("/evolve suggest")).toContain("no open suggestions");

    // No plugin dir scaffolded for prompt_rule fixes.
    const pluginDirs = await readdir(join(dir, ".flavorlite", "plugins"));
    expect(pluginDirs.filter((entry) => entry.startsWith("fix-"))).toHaveLength(0);
  });

  it("injects an evolve-rules section only once rules.md has content", async () => {
    const assemble = () =>
      hooks().waterfall<PromptAssemble>("prompt/assemble", { cwd: dir, sections: [] });

    let payload = await assemble();
    expect(payload.sections.find((section) => section.name === "evolve-rules")).toBeUndefined();

    const id = await raiseSuggestion("frobnicate");
    await callTool("evolve_improve", {
      suggestionId: id,
      implementation: "Never run rm -rf without an explicit user confirmation.",
      kind: "prompt_rule",
    });

    payload = await assemble();
    const rulesSection = payload.sections.find((section) => section.name === "evolve-rules");
    expect(rulesSection?.content).toContain("Never run rm -rf without an explicit user confirmation.");
  });

  it("evolve_improve default kind still scaffolds a fix plugin", async () => {
    const id = await raiseSuggestion("shell");

    const result = await callTool("evolve_improve", {
      suggestionId: id,
      implementation: "wrap shell with safer defaults",
    });
    expect(result.isError).not.toBe(true);
    expect(String(result.content)).toContain("Scaffolded fix plugin");

    const pluginDirs = await readdir(join(dir, ".flavorlite", "plugins"));
    expect(pluginDirs).toContain("fix-shell");
  });

  it("proposes a new tool once a success trigram repeats across enough runs", async () => {
    expect(await commands().execute("/evolve suggest")).toContain("no open suggestions");

    await runOnceWithSequence(["Read", "Grep", "Write"]);
    await runOnceWithSequence(["Read", "Grep", "Write"]);
    let patterns = await readPatterns(dir);
    expect(patterns.find((p) => p.sequence.join("->") === "Read->Grep->Write")?.count).toBe(2);
    expect(await commands().execute("/evolve suggest")).not.toContain("tool proposal");

    await runOnceWithSequence(["Read", "Grep", "Write"]);
    patterns = await readPatterns(dir);
    expect(patterns.find((p) => p.sequence.join("->") === "Read->Grep->Write")?.count).toBe(3);

    const suggest = await commands().execute("/evolve suggest");
    expect(suggest).toContain("tool proposal");
    expect(suggest).toContain("Read->Grep->Write");
  });

  it("counts a trigram once per run even if it repeats within the run", async () => {
    await runOnceWithSequence(["Read", "Grep", "Write", "Read", "Grep", "Write"]);

    const patterns = await readPatterns(dir);
    expect(patterns.find((p) => p.sequence.join("->") === "Read->Grep->Write")?.count).toBe(1);
  });
});
