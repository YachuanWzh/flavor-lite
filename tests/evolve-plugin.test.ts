import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
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

interface StubSession {
  id: string;
  messages: Array<{ role: string; content: string }>;
}

/** Controllable session stub (evolve only reads it via tryGet). */
let stubSessions: StubSession[] = [];

function stubSessionPlugin() {
  return definePlugin({
    name: "stub-session",
    provides: ["session"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("session", {
            list: async () => stubSessions.map((session) => ({ id: session.id })),
            latest: async () => stubSessions[0]?.id,
            open: async (id: string) => {
              const found = stubSessions.find((session) => session.id === id);
              if (!found) throw new Error(`no session ${id}`);
              return { messages: () => found.messages };
            },
          }),
        "stub-session.install",
      );
    },
  });
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
    stubSessions = [];
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(stubSessionPlugin())
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

  it("/evolve export writes clean SFT trajectories, dropping meta and short sessions", async () => {
    stubSessions.push(
      {
        id: "s1",
        messages: [
          { role: "user", content: "fix the parser bug" },
          { role: "assistant", content: "I will inspect parser.ts first." },
          { role: "user", content: "[steering] no, use the lexer instead" },
          { role: "assistant", content: "Switching to the lexer path." },
          { role: "user", content: "great, run the tests" },
          { role: "assistant", content: "All tests pass." },
        ],
      },
      // Too short after filtering: not a complete trajectory.
      {
        id: "s2",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    );

    const out = (await commands().execute("/evolve export")) ?? "";
    expect(out).toContain("exported 1 session");
    expect(out).toContain("sft.jsonl");

    const text = await readFile(join(dir, ".flavorlite", "evolve", "sft.jsonl"), "utf-8");
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sessionId: string; messages: Array<{ role: string; content: string }> });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sessionId).toBe("s1");
    expect(lines[0]!.messages).toHaveLength(5); // steering meta dropped
    expect(JSON.stringify(lines[0]!.messages)).not.toContain("[steering]");
    expect(lines[0]!.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
  });

  it("/evolve export reports when no session qualifies", async () => {
    const out = (await commands().execute("/evolve export")) ?? "";
    expect(out).toContain("exported 0 session");
  });

  it("/evolve learn writes confirmed recall tokens back into manifest triggers", async () => {
    const memory = [
      { fp: ["hotreload", "plugin"], plugin: "evolve", used: true },
      { fp: ["hotreload", "noise"], plugin: "evolve", used: false },
    ];
    await writeFile(join(dir, ".flavorlite", "router-memory.json"), JSON.stringify(memory), "utf-8");

    const out = (await commands().execute("/evolve learn")) ?? "";
    expect(out).toContain("learned triggers: evolve");
    expect(out).toContain("plugin");

    const manifest = JSON.parse(
      await readFile(join(dir, ".flavorlite", "plugins", "evolve", "flavor-plugin.json"), "utf-8"),
    );
    // "plugin" scores +1; "hotreload" nets 0; "noise" nets -1.
    expect(manifest.triggers.keywords).toContain("plugin");
    expect(manifest.triggers.keywords).not.toContain("noise");
    expect(manifest.triggers.keywords).not.toContain("hotreload");

    // Idempotent: a second pass finds nothing new.
    expect(await commands().execute("/evolve learn")).toContain("no new triggers learned");
  });

  it("/evolve learn degrades gracefully without router feedback", async () => {
    expect(await commands().execute("/evolve learn")).toContain("no router feedback memory found");
  });

  it("/evolve suggest surfaces analyzed error-monitor records and done closes them", async () => {
    const recordId = "abc123def456";
    await mkdir(join(dir, ".flavorlite", "error-monitor"), { recursive: true });
    await writeFile(
      join(dir, ".flavorlite", "error-monitor", "records.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: recordId,
            tool: "Shell",
            kind: "shell_exit",
            count: 3,
            lesson: "rule-based lesson",
            analysis: "Quote Windows paths in shell commands.",
            confidence: 0.9,
            lastAt: new Date().toISOString(),
          },
          {
            id: "lowconf000001",
            tool: "Shell",
            kind: "shell_exit",
            count: 2,
            lesson: "x",
            analysis: "unsure what happened",
            confidence: 0.3,
            lastAt: new Date().toISOString(),
          },
        ],
      }),
      "utf-8",
    );

    const suggest = (await commands().execute("/evolve suggest")) ?? "";
    expect(suggest).toContain(`[em:${recordId}]`);
    expect(suggest).toContain("Quote Windows paths in shell commands.");
    expect(suggest).not.toContain("[em:lowconf");

    await commands().execute(`/evolve done em:${recordId}`);
    expect(await commands().execute("/evolve suggest")).not.toContain(`[em:${recordId}]`);
  });

  it("evolve_improve consumes an error-monitor suggestion as a prompt rule", async () => {
    const recordId = "em0000feed01";
    await mkdir(join(dir, ".flavorlite", "error-monitor"), { recursive: true });
    await writeFile(
      join(dir, ".flavorlite", "error-monitor", "records.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: recordId,
            tool: "Shell",
            kind: "shell_exit",
            count: 4,
            lesson: "rule-based lesson",
            analysis: "Always forward-slash paths passed to cmd.exe.",
            confidence: 0.85,
            lastAt: new Date().toISOString(),
          },
        ],
      }),
      "utf-8",
    );

    const result = await callTool("evolve_improve", {
      suggestionId: `em:${recordId}`,
      implementation: "Forward-slash all paths passed to cmd.exe.",
      kind: "prompt_rule",
    });
    expect(result.isError).not.toBe(true);
    expect(await readRulesFile(dir)).toContain("Forward-slash all paths passed to cmd.exe.");
    expect(await commands().execute("/evolve suggest")).not.toContain(`[em:${recordId}]`);
  });
});

describe("evolve export without a session service", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-evolve-nosession-"));
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
    const loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the missing service instead of throwing", async () => {
    const commands = runtime.ctx.get("commands") as CommandsService;
    const out = (await commands.execute("/evolve export")) ?? "";
    expect(out).toContain("no session service available");
  });
});
