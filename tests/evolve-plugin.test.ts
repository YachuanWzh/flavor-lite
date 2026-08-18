import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { toolsPlugin } from "../src/plugins/tools";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { AfterToolCall } from "../src/plugins/tools/registry";
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
});
