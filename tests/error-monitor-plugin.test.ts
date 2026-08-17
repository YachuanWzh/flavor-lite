import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { AfterToolCall } from "../src/plugins/tools/registry";
import {
  buildLesson,
  classifyError,
  ErrorRecordStore,
  extractErrorLine,
  redactSecrets,
  windowsShellHints,
} from "../.flavorlite/plugins/error-monitor/records.js";

/**
 * The plugin under test is loaded the way a user loads it: through the
 * plugins loader, from the real .flavorlite/plugins/error-monitor/ directory
 * (copied into an isolated temp root so other disk plugins stay out). The
 * memory-integration cases also copy the real memory plugin, minus its
 * embedding.json, so recall stays BM25-only and no network is attempted.
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/error-monitor", import.meta.url));
const MEMORY_PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/memory", import.meta.url));

const WIN_SHELL_ERROR = [
  "'frobnicate' is not recognized as an internal or external command,",
  "operable program or batch file.",
  "",
  "[stderr]",
  "'frobnicate' is not recognized as an internal or external command.",
  "",
  "[exit code: 9009]",
].join("\n");

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

type MemoryService = {
  store: {
    list: () => Promise<Array<{ id: string; type: string; content: string }>>;
  };
};

describe("error-monitor plugin", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-error-monitor-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
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

  async function recordsFile(): Promise<{ version: number; records: Array<Record<string, unknown>> }> {
    try {
      return JSON.parse(await readFile(join(dir, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
    } catch {
      // No failures recorded yet → the log file has not been created.
      return { version: 1, records: [] };
    }
  }

  it("loads and registers /errors", async () => {
    const status = loader.list().find((entry) => entry.name === "error-monitor");
    expect(status?.status).toBe("loaded");
    expect(await commands().execute("/errors")).toBe("No tool errors recorded yet.");
  });

  it("records a failing Windows shell command with a cmd.exe-aware lesson", async () => {
    await fireError(shellCall("frobnicate --bogus"), { content: WIN_SHELL_ERROR, isError: true });

    const { records } = await recordsFile();
    expect(records).toHaveLength(1);
    const record = records[0] as { tool: string; kind: string; command: string; count: number; lesson: string };
    expect(record.tool).toBe("Shell");
    expect(record.kind).toBe("shell_exit");
    expect(record.command).toBe("frobnicate --bogus");
    expect(record.count).toBe(1);
    expect(record.lesson).toContain("not recognized");
    expect(record.lesson).toContain("PATH");

    const output = await commands().execute("/errors");
    expect(output).toContain("[shell_exit]");
    expect(output).toContain("frobnicate --bogus");
  });

  it("deduplicates identical failures (count bumps, no new record)", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });

    const { records } = await recordsFile();
    expect(records).toHaveLength(1);
    expect((records[0] as { count: number }).count).toBe(3);
  });

  it("records distinct failures separately", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });
    await fireError(shellCall("npm run missing-script"), {
      content: "npm error Missing script: \"missing-script\"\n\n[exit code: 1]",
      isError: true,
    });

    const { records } = await recordsFile();
    expect(records).toHaveLength(2);
  });

  it("ignores successful tool results", async () => {
    await fireError(shellCall("dir"), { content: "Volume in drive C has no label.\n\n[exit code: 0]", isError: false });
    await fireError({ id: "call_2", name: "Read", args: { path: "x" } }, { content: "file contents" });

    const { records } = await recordsFile();
    expect(records).toHaveLength(0);
    expect(await commands().execute("/errors")).toBe("No tool errors recorded yet.");
  });

  it("records non-shell tool errors (unknown tool, invalid args, network)", async () => {
    await fireError({ id: "call_1", name: "Nope", args: {} }, {
      content: 'Tool "Nope" not found. Available tools: Shell, Read',
      isError: true,
    });
    await fireError({ id: "call_2", name: "Shell", args: {} }, {
      content: "Missing required argument: command",
      isError: true,
    });
    await fireError({ id: "call_3", name: "WebFetch", args: { url: "https://example.invalid" } }, {
      content: "fetch failed: getaddrinfo ENOTFOUND example.invalid",
      isError: true,
    });

    const { records } = await recordsFile();
    expect(records).toHaveLength(3);
    const byKind = Object.fromEntries(records.map((record) => [record.kind, record]));
    expect(byKind["tool_not_found"]).toBeDefined();
    expect(byKind["invalid_args"]).toBeDefined();
    expect(byKind["network"]).toBeDefined();
  });

  it("injects no lesson section into the system prompt before any error", async () => {
    const assembled = await hooks().waterfall("prompt/assemble", { cwd: dir, sections: [] });
    expect(assembled.sections.find((entry) => entry.name === "tool-error-lessons")).toBeUndefined();
  });

  it("injects lessons into the system prompt via prompt/assemble", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });

    const assembled = await hooks().waterfall("prompt/assemble", { cwd: dir, sections: [] });
    const section = assembled.sections.find((entry) => entry.name === "tool-error-lessons");
    expect(section).toBeDefined();
    expect(section?.content).toContain("frobnicate");
    expect(section?.content).toContain("shell_exit");
    expect(section?.content).toContain("avoid repeating");
  });

  it("clears the local log with /errors clear", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });
    expect(await commands().execute("/errors clear")).toContain("Cleared");
    expect(await commands().execute("/errors")).toBe("No tool errors recorded yet.");
  });

  it("supports ignorePatterns to skip known-benign failures", async () => {
    const store = new ErrorRecordStore({
      workspace: dir,
      ignorePatterns: ["nothing to commit", "no match found"],
    });
    const first = await store.record({
      tool: "Shell",
      args: { command: "git status" },
      result: { content: "nothing to commit, working tree clean\n\n[exit code: 1]", isError: true },
    });
    expect(first.ignored).toBe(true);
    expect(first.added).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it("redacts secrets from stored details", async () => {
    expect(redactSecrets("api_key=sk-abcdef1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwx")).toBe("Bearer [REDACTED]");
    expect(redactSecrets("no secrets here")).toBe("no secrets here");
  });
});

describe("error-monitor + memory integration", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-error-mem-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);
    const memoryDir = await copyDir(MEMORY_PLUGIN_SOURCE, pluginsRoot);
    // Keep the integration hermetic: no local embedding endpoint in tests.
    await rm(join(memoryDir, "embedding.json"), { force: true });
    // These integration cases exercise the rule-based fallback explicitly
    // (default fallbackToRules is false: no LLM → no memory write).
    const manifestPath = join(pluginsRoot, "error-monitor", "flavor-plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.config = { ...manifest.config, fallbackToRules: true };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    await (runtime.ctx.get("pluginsLoader") as PluginsLoaderService).init();
  });

  afterEach(async () => {
    // Let any fire-and-forget distillation finish writing before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function memory(): MemoryService {
    return runtime.ctx.get("memory") as MemoryService;
  }

  /** Poll until predicate is true (distillation is fire-and-forget). */
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for async distillation");
  }

  async function fireError(toolCall: AfterToolCall["toolCall"], result: AfterToolCall["result"]): Promise<void> {
    await (runtime.ctx.get("hooks") as HookBusService).waterfall<AfterToolCall>("tools/after-call", {
      toolCall,
      args: toolCall.args,
      result,
    });
  }

  it("stores a distilled lesson in long-term memory and deduplicates at the record level", async () => {
    expect(runtime.ctx.tryGet("memory")).toBeDefined();

    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });

    // Distillation is fire-and-forget; wait for the async memory write.
    await waitFor(async () => (await memory().store.list()).some((entry) => entry.type === "feedback"));

    const entries = await memory().store.list();
    const lesson = entries.find((entry) => entry.type === "feedback");
    expect(lesson).toBeDefined();
    expect(lesson?.content).toContain("PATH");

    // The same failure again adds no second memory entry (record-level dedupe
    // means the lesson write only happens for brand-new records).
    await fireError(shellCall("frobnicate", "call_2"), { content: WIN_SHELL_ERROR, isError: true });
    const after = await memory().store.list();
    expect(after.filter((entry) => entry.type === "feedback")).toHaveLength(1);
  });

  it("persists the memory outcome on the record (silent-logger diagnostics)", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });

    // memoryStatus is persisted LAST by the distillation, so polling for it
    // also covers the memory write (avoids reading a stale records.json).
    await waitFor(async () => {
      const raw = JSON.parse(await readFile(join(dir, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
      return raw.records[0]?.memoryStatus === "stored (rule-based fallback)";
    });

    const raw = JSON.parse(await readFile(join(dir, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
    expect(raw.records[0].memoryStatus).toBe("stored (rule-based fallback)");
    const output = await (runtime.ctx.get("commands") as CommandsService).execute("/errors");
    expect(output).toContain("memory: stored (rule-based fallback)");
  });

  it("keeps memory lessons when /errors clear empties the local log", async () => {
    await fireError(shellCall("frobnicate"), { content: WIN_SHELL_ERROR, isError: true });

    await waitFor(async () => (await memory().store.list()).some((entry) => entry.type === "feedback"));

    const cleared = await (runtime.ctx.get("commands") as CommandsService).execute("/errors clear");
    expect(cleared).toContain("Cleared");

    expect((await memory().store.list()).filter((entry) => entry.type === "feedback")).toHaveLength(1);
  });
});

describe("error-monitor without an llm service (default fallbackToRules=false)", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-error-nollm-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);
    const memoryDir = await copyDir(MEMORY_PLUGIN_SOURCE, pluginsRoot);
    await rm(join(memoryDir, "embedding.json"), { force: true });

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    await (runtime.ctx.get("pluginsLoader") as PluginsLoaderService).init();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("records the failure locally but writes NOTHING to long-term memory", async () => {
    expect(runtime.ctx.tryGet("llm")).toBeUndefined();

    await (runtime.ctx.get("hooks") as HookBusService).waterfall<AfterToolCall>("tools/after-call", {
      toolCall: shellCall("frobnicate"),
      args: { command: "frobnicate" },
      result: { content: WIN_SHELL_ERROR, isError: true },
    });

    // Local record exists (dedup store works without any LLM).
    const records = JSON.parse(await readFile(join(dir, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
    expect(records.records).toHaveLength(1);

    // Long-term memory stays empty: no LLM analysis → no memory write.
    const memory = runtime.ctx.get("memory") as MemoryService;
    expect(await memory.store.list()).toHaveLength(0);

    // ...but the record explains why, so /errors can diagnose it even with
    // a silent host logger. memoryStatus is persisted asynchronously after
    // the record itself — poll for it instead of sleeping a fixed delay.
    const recordsPath = join(dir, ".flavorlite", "error-monitor", "records.json");
    const deadline = Date.now() + 3000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      const reread = JSON.parse(await readFile(recordsPath, "utf-8"));
      status = (reread.records[0] as { memoryStatus?: string }).memoryStatus;
      if (status) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toContain("no llm service available");
  });
});

describe("error-monitor classification & lessons", () => {
  it("classifies error kinds", () => {
    expect(classifyError("[exit code: 1]")).toBe("shell_exit");
    expect(classifyError("[spawn error] ENOENT")).toBe("shell_spawn");
    expect(classifyError("[killed after 120000ms timeout]")).toBe("shell_timeout");
    expect(classifyError('Tool "Foo" not found. Available tools: none')).toBe("tool_not_found");
    expect(classifyError("Missing required argument: command")).toBe("invalid_args");
    expect(classifyError("fetch failed: ECONNREFUSED 127.0.0.1:80")).toBe("network");
    expect(classifyError("ENOENT: no such file or directory, open 'x.txt'")).toBe("file");
    expect(classifyError("something odd happened")).toBe("unknown");
  });

  it("extracts the first meaningful error line", () => {
    expect(extractErrorLine(WIN_SHELL_ERROR)).toContain("not recognized");
    expect(extractErrorLine("[exit code: 2]")).toBe("[exit code: 2]");
  });

  it("adds Windows hints only on win32 and only for shell kinds", () => {
    const windows = buildLesson({
      tool: "Shell",
      kind: "shell_exit",
      content: WIN_SHELL_ERROR,
      command: "frobnicate",
      platform: "win32",
    });
    expect(windows).toContain("PATH");
    expect(windows).toContain("where");

    const posix = buildLesson({
      tool: "Shell",
      kind: "shell_exit",
      content: WIN_SHELL_ERROR,
      command: "frobnicate",
      platform: "linux",
    });
    expect(posix).not.toContain("PATH");

    expect(windowsShellHints("'x' is not recognized as an internal or external command")).toHaveLength(2);
    expect(windowsShellHints("npm error Missing script")).toEqual([]);
  });

  it("caps lessons at a bounded length", () => {
    const long = buildLesson({
      tool: "Shell",
      kind: "unknown",
      content: "error: boom",
      command: `run --flag ${"z".repeat(2000)}`,
      platform: "linux",
    });
    expect(long.length).toBeLessThanOrEqual(560);
    expect(long.endsWith("...")).toBe(true);
  });

  it("lessons() prefer the LLM analysis over the rule-based lesson", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "flavor-error-lessons-"));
    try {
      const store = new ErrorRecordStore({ workspace: tmp });
      const { record } = await store.record({
        tool: "Shell",
        args: { command: "frobnicate" },
        result: { content: WIN_SHELL_ERROR, isError: true },
      });
      await store.attachAnalysis(record!.id, "DISTILLED-INSIGHT from the LLM", 0.9);

      const lines = await store.lessons();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("DISTILLED-INSIGHT");
      expect(lines[0]).not.toContain("Fix the command or its inputs");

      // Without an analysis the rule-based lesson still leads.
      const { record: second } = await store.record({
        tool: "Shell",
        args: { command: "other-tool" },
        result: { content: "npm error Missing script\n\n[exit code: 1]", isError: true },
      });
      expect(second).toBeDefined();
      const both = await store.lessons();
      expect(both.some((line) => line.includes("DISTILLED-INSIGHT"))).toBe(true);
      expect(both.some((line) => line.includes("Shell exited non-zero"))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps a lesson free of secrets even when the error mentions credentials", () => {
    const lesson = buildLesson({
      tool: "WebFetch",
      kind: "network",
      content: "fetch failed with api_key=sk-abcdef1234567890 and token=zzz",
      platform: "linux",
    });
    expect(lesson).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(lesson).toContain("network/link call failed");
  });
});
