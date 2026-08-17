import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin } from "../src/plugins/prompt";
import { llmPlugin, type LlmService } from "../src/plugins/llm";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { AfterToolCall } from "../src/plugins/tools/registry";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/plugins/llm/types";
import {
  analyzeWithLlm,
  buildAnalysisPrompt,
  buildEnvironmentInfo,
  collectLlmText,
  parseAnalysisResult,
  type AnalysisInput,
} from "../.flavorlite/plugins/error-monitor/analyze.js";

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

function textTurn(text: string): ModelEvent[] {
  return [{ type: "text_delta", text }, { type: "done", stopReason: "end" }];
}

describe("error-monitor LLM analysis (analyze.js)", () => {
  const record: AnalysisInput["record"] = {
    id: "abc123def456",
    tool: "Shell",
    kind: "shell_exit",
    signature: "sig",
    command: "frobnicate --bogus",
    detail: WIN_SHELL_ERROR,
    lesson: "rule-based fallback",
    count: 1,
    firstAt: "2026-08-16T00:00:00.000Z",
    lastAt: "2026-08-16T00:00:00.000Z",
    args: { command: "frobnicate --bogus", api_key: "sk-abcdef1234567890" },
  };

  it("builds a prompt with tool, kind, command, args, error, and environment", () => {
    const prompt = buildAnalysisPrompt({
      record,
      environment: buildEnvironmentInfo({ cwd: "C:\\work" }),
    });
    expect(prompt).toContain("- tool: Shell");
    expect(prompt).toContain("- kind: shell_exit");
    expect(prompt).toContain("- command: frobnicate --bogus");
    expect(prompt).toContain("- arguments:");
    expect(prompt).toContain("not recognized");
    expect(prompt).toContain("- platform:");
    expect(prompt).toContain("- node:");
    expect(prompt).toContain("- shell:");
    expect(prompt).toContain("- cwd: C:\\work");
    expect(prompt).toContain('"confidence"');
  });

  it("redacts secrets before they reach the prompt", () => {
    const prompt = buildAnalysisPrompt({ record, environment: undefined, includeArgs: true });
    expect(prompt).not.toContain("sk-abcdef1234567890");
    expect(prompt).not.toContain("api_key");
    expect(prompt).toContain("[REDACTED]");
  });

  it("omits arguments when includeArgs is false", () => {
    const prompt = buildAnalysisPrompt({ record, environment: undefined, includeArgs: false });
    expect(prompt).not.toContain("- arguments:");
  });

  it("parses strict JSON replies", () => {
    expect(parseAnalysisResult('{"analysis":"use full path","confidence":0.9}')).toEqual({
      analysis: "use full path",
      confidence: 0.9,
    });
    expect(parseAnalysisResult('```json\n{"analysis":"a","confidence":0.8}\n```')).toEqual({
      analysis: "a",
      confidence: 0.8,
    });
    // trailing prose is tolerated (first { to last })
    expect(parseAnalysisResult('Here you go: {"analysis":"a","confidence":0.5}')).toEqual({
      analysis: "a",
      confidence: 0.5,
    });
  });

  it("rejects malformed or out-of-range replies", () => {
    expect(parseAnalysisResult("not json")).toBeUndefined();
    expect(parseAnalysisResult('{"analysis":"a"}')).toBeUndefined(); // no confidence
    expect(parseAnalysisResult('{"confidence":0.9}')).toBeUndefined(); // no analysis
    expect(parseAnalysisResult('{"analysis":"a","confidence":1.5}')).toBeUndefined();
    expect(parseAnalysisResult('{"analysis":"a","confidence":-0.1}')).toBeUndefined();
    expect(parseAnalysisResult('{"analysis":"a","confidence":"high"}')).toBeUndefined();
  });

  it("analyzeWithLlm returns success with the parsed analysis", async () => {
    const llm = {
      stream: async function* (options: { systemPrompt: string; messages: Array<{ role: string; content: string }> }) {
        expect(options.messages[0]!.content).toContain("frobnicate");
        yield { type: "text_delta", text: '{"analysis":"use where to locate the command","confidence":0.85}' };
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await analyzeWithLlm({ llm, record, environment: undefined });
    expect(result).toEqual({
      status: "success",
      analysis: "use where to locate the command",
      confidence: 0.85,
    });
  });

  it("collectLlmText aborts a hung stream after timeoutMs", async () => {
    const hung = {
      async *stream(options: { signal?: AbortSignal }) {
        if (options.signal?.aborted) throw new Error("aborted");
        await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const start = Date.now();
    const text = await collectLlmText(hung, { systemPrompt: "", messages: [] }, 50);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(text).toBeUndefined();
  });

  it("retries a transient provider failure and succeeds on the second attempt", async () => {
    let calls = 0;
    const flaky = {
      async *stream(options: { signal?: AbortSignal }) {
        calls += 1;
        if (calls === 1) throw new Error("Provider stream ended without a done or error event");
        yield { type: "text_delta", text: '{"analysis":"use where to locate it","confidence":0.9}' };
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await analyzeWithLlm({ llm: flaky, record, environment: undefined, config: { retryCount: 1, retryBackoffMs: 5 } });
    expect(result.status).toBe("success");
    expect(calls).toBe(2);
  });

  it("gives up after retryCount with the last real error", async () => {
    let calls = 0;
    const alwaysFails = {
      async *stream() {
        calls += 1;
        throw new Error("provider down");
      },
    };
    const result = await analyzeWithLlm({ llm: alwaysFails, record, environment: undefined, config: { retryCount: 1, retryBackoffMs: 5 } });
    expect(result.status).toBe("error");
    expect((result as { reason: string }).reason).toBe("provider down");
    expect(calls).toBe(2);
  });

  it("analyzeWithLlm returns error statuses for empty/unparseable/throwing streams", async () => {
    // retryCount 0 keeps these unit cases off the (intentionally slow)
    // production backoff schedule.
    const noRetry = { retryCount: 0 };
    const empty = { stream: async function* () {} };
    expect((await analyzeWithLlm({ llm: empty, record, environment: undefined, config: noRetry })).status).toBe("error");

    const garbage = {
      stream: async function* () {
        yield { type: "text_delta", text: "sorry, I cannot analyze this" };
      },
    };
    const unparseable = await analyzeWithLlm({ llm: garbage, record, environment: undefined, config: noRetry });
    expect(unparseable.status).toBe("error");
    expect((unparseable as { reason: string }).reason).toBe("unparseable");

    const throwing = {
      stream: async function* () {
        throw new Error("provider down");
      },
    };
    const failed = await analyzeWithLlm({ llm: throwing, record, environment: undefined, config: noRetry });
    expect(failed.status).toBe("error");
    // The real error message must be preserved so /errors can show why.
    expect((failed as { reason: string }).reason).toBe("provider down");
  });

  it("retries EMPTY replies too (the live-session failure mode)", async () => {
    let calls = 0;
    const emptyThenOk = {
      async *stream() {
        calls += 1;
        if (calls === 1) return; // stream ends without a single token
        yield { type: "text_delta", text: '{"analysis":"use PowerShell syntax","confidence":0.8}' };
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await analyzeWithLlm({ llm: emptyThenOk, record, environment: undefined, config: { retryCount: 1, retryBackoffMs: 5 } });
    expect(result.status).toBe("success");
    expect(calls).toBe(2);
  });
});

describe("error-monitor LLM integration (through the plugins loader)", () => {
  let dir: string;
  let runtime: Runtime;
  let requests: ModelRequest[];

  function fakeAdapter(script: (request: ModelRequest) => ModelEvent[]): ModelAdapter {
    return {
      type: "fake",
      async *stream(request: ModelRequest) {
        requests.push(request);
        for (const event of script(request)) yield event;
      },
    };
  }

  async function mount(adapter: ModelAdapter, manifestConfig: Record<string, unknown> = {}) {
    dir = await mkdtemp(join(tmpdir(), "flavor-error-llm-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);
    const memoryDir = await copyDir(MEMORY_PLUGIN_SOURCE, pluginsRoot);
    await rm(join(memoryDir, "embedding.json"), { force: true }); // BM25-only, no network

    // Manifest config overrides for the plugin under test (nested llm merges).
    const manifestPath = join(pluginsRoot, "error-monitor", "flavor-plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      config: { llm: Record<string, unknown> };
    };
    manifest.config = {
      ...manifest.config,
      ...manifestConfig,
      llm: { ...manifest.config.llm, ...((manifestConfig.llm ?? {}) as Record<string, unknown>) },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(llmPlugin, { providers: { fake: { adapter, defaultModel: "fake-1" } } })
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    await (runtime.ctx.get("pluginsLoader") as PluginsLoaderService).init();
    return runtime;
  }

  beforeEach(() => {
    dir = "";
    requests = [];
  });

  afterEach(async () => {
    // Let any fire-and-forget distillation finish writing before cleanup,
    // otherwise rm() can race the background task (ENOTEMPTY).
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (runtime) await runtime.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function memory() {
    return runtime.ctx.get("memory") as {
      store: { list: () => Promise<Array<{ id: string; type: string; content: string }>> };
    };
  }

  async function fireError() {
    const toolCall: AfterToolCall["toolCall"] = {
      id: "call_1",
      name: "Shell",
      args: { command: "frobnicate --bogus" },
    };
    await (runtime.ctx.get("hooks") as HookBusService).waterfall<AfterToolCall>("tools/after-call", {
      toolCall,
      args: toolCall.args,
      result: { content: WIN_SHELL_ERROR, isError: true },
    });
  }

  async function recordsFile() {
    return JSON.parse(await readFile(join(dir, ".flavorlite", "error-monitor", "records.json"), "utf-8"));
  }

  /** Poll until predicate is true (distillation is fire-and-forget). */
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for async distillation");
  }

  it("sends the failure (with environment) to the LLM and stores high-confidence analyses", async () => {
    await mount(fakeAdapter(() => textTurn(JSON.stringify({
      analysis: "Use 'where frobnicate' to locate the tool, then call its full path.",
      confidence: 0.92,
    }))));

    expect(runtime.ctx.tryGet("llm")).toBeDefined();
    expect((runtime.ctx.get("llm") as LlmService).providers()).toContain("fake");

    await fireError();

    // The LLM request carried the failure context.
    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.messages[0]!.content;
    expect(prompt).toContain("- tool: Shell");
    expect(prompt).toContain("- command: frobnicate --bogus");
    expect(prompt).toContain("- platform:");
    expect(prompt).toContain("- node:");
    expect(prompt).toContain("- cwd:");

    // Distillation is fire-and-forget; memoryStatus is persisted LAST, so
    // waiting for it covers both the memory write and the record update.
    await waitFor(async () => (await recordsFile()).records[0]?.memoryStatus === "stored");

    // High confidence → distilled into long-term memory as feedback.
    const entries = await memory().store.list();
    expect(entries.find((entry) => entry.type === "feedback")?.content).toContain("where frobnicate");

    // The record keeps the analysis and its confidence.
    const { records } = await recordsFile();
    expect(records[0].analysis).toContain("where frobnicate");
    expect(records[0].confidence).toBe(0.92);
    // The memory outcome is durably diagnosable via the record itself
    // (hosts commonly run with a silent logger).
    expect(records[0].memoryStatus).toBe("stored");
    expect(await (runtime.ctx.get("commands") as CommandsService).execute("/errors")).toContain("memory: stored");
  });

  it("surfaces the stored analysis (not the rule-based lesson) in the system prompt", async () => {
    await mount(fakeAdapter(() => textTurn(JSON.stringify({
      analysis: "DISTILLED-INSIGHT use where frobnicate",
      confidence: 0.9,
    }))));

    await fireError();
    await waitFor(async () => (await recordsFile()).records[0]?.analysis != null);

    const assembled = await (runtime.ctx.get("hooks") as HookBusService).waterfall("prompt/assemble", { cwd: dir, sections: [] });
    const section = assembled.sections.find((entry: { name: string }) => entry.name === "tool-error-lessons");
    expect(section?.content).toContain("DISTILLED-INSIGHT");
  });

  it("does not memorize low-confidence analyses (keeps them in the record)", async () => {
    await mount(fakeAdapter(() => textTurn(JSON.stringify({
      analysis: "Something about the command was wrong.",
      confidence: 0.3,
    }))));

    await fireError();

    // Wait for the async analysis to be attached to the record AND for the
    // skip outcome to be persisted (memoryStatus lands after the analysis).
    await waitFor(async () => (await recordsFile()).records[0]?.memoryStatus?.includes("confidence") === true);

    expect((await memory().store.list()).filter((entry) => entry.type === "feedback")).toHaveLength(0);

    const { records } = await recordsFile();
    expect(records[0].confidence).toBe(0.3);
    expect(records[0].analysis).toContain("Something about");
    // Why nothing reached memory is visible without a live logger.
    expect(records[0].memoryStatus).toContain("confidence 0.30 < threshold");
  });

  it("writes NOTHING to memory by default when the LLM stream throws (no rule fallback)", async () => {
    await mount(fakeAdapter(() => {
      throw new Error("provider down");
    }), { llm: { retryCount: 0, retryBackoffMs: 5 } });

    await fireError();

    // The LLM call throws; memoryStatus is persisted last, so waiting for it
    // also covers the (absent) memory write.
    await waitFor(async () => (await recordsFile()).records[0]?.memoryStatus?.startsWith("skipped") === true);
    expect((await memory().store.list()).filter((entry) => entry.type === "feedback")).toHaveLength(0);
    // The failure is still recorded locally for inspection, with the reason
    // surfaced so /errors explains why nothing was distilled.
    const { records } = await recordsFile();
    expect(records[0].analysisError).toContain("provider down");
    expect(records[0].memoryStatus).toContain("LLM analysis failed");
    expect(await (runtime.ctx.get("commands") as CommandsService).execute("/errors")).toContain("analysis error");
  });

  it("falls back to the rule-based lesson only when fallbackToRules is explicitly enabled", async () => {
    await mount(
      fakeAdapter(() => {
        throw new Error("provider down");
      }),
      // retryCount 0: this case asserts the fallback PATH, not the retry
      // policy — the production backoff would outrun the test's patience.
      { fallbackToRules: true, llm: { retryCount: 0 } },
    );

    await fireError();

    await waitFor(
      async () => (await recordsFile()).records[0]?.memoryStatus === "stored (rule-based fallback)",
    );

    const entries = await memory().store.list();
    const lesson = entries.find((entry) => entry.type === "feedback");
    expect(lesson).toBeDefined();
    expect(lesson?.content).toContain("PATH"); // rule-based Windows hint

    const { records } = await recordsFile();
    expect(records[0].memoryStatus).toBe("stored (rule-based fallback)");
  });

  it("aborts a hung LLM call after timeoutMs without blocking the loop or writing memory", async () => {
    await mount(
      {
        type: "fake",
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (request.signal?.aborted) throw new Error("aborted");
          await new Promise((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      { llm: { timeoutMs: 100, retryCount: 0 } },
    );

    const started = Date.now();
    await fireError();
    // The tool loop is not blocked: record() is fast, distillation is async.
    expect(Date.now() - started).toBeLessThan(1500);

    // Give the background task time to hit the timeout.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { records } = await recordsFile();
    expect(records[0].analysis).toBeUndefined();
    expect((await memory().store.list()).filter((entry) => entry.type === "feedback")).toHaveLength(0);
  });

  it("respects includeArgs: false so arguments never reach the LLM", async () => {
    let promptText = "";
    await mount(
      fakeAdapter((request) => {
        promptText = request.messages[0]!.content;
        return textTurn(JSON.stringify({ analysis: "Use the full path.", confidence: 0.8 }));
      }),
      { llm: { includeArgs: false } },
    );

    await fireError();
    expect(promptText).not.toContain("- arguments:");
  });

  it("/errors analyze re-distills records that failed with empty replies", async () => {
    let calls = 0;
    await mount(
      fakeAdapter(() => {
        calls += 1;
        // First distillation burst: the gateway answers with empty streams
        // (the live-session failure mode). The manual re-run succeeds.
        if (calls === 1) return [];
        return textTurn(JSON.stringify({
          analysis: "Retry lesson: use PowerShell-compatible syntax.",
          confidence: 0.9,
        }));
      }),
      { llm: { retryCount: 0 } },
    );

    await fireError();
    await waitFor(async () => (await recordsFile()).records[0]?.memoryStatus?.startsWith("skipped") === true);
    expect((await recordsFile()).records[0].analysisError).toContain("empty");

    // Manual re-run picks up every record without an analysis.
    const queued = await (runtime.ctx.get("commands") as CommandsService).execute("/errors analyze");
    expect(queued).toContain("Queued 1 record(s)");

    await waitFor(async () => (await recordsFile()).records[0]?.memoryStatus === "stored");
    const { records } = await recordsFile();
    expect(records[0].analysis).toContain("Retry lesson");
    expect(records[0].memoryStatus).toBe("stored");
    expect((await memory().store.list()).some((entry) => entry.type === "feedback")).toBe(true);

    // Nothing pending anymore.
    expect(await (runtime.ctx.get("commands") as CommandsService).execute("/errors analyze"))
      .toContain("Nothing to re-analyze");
  });
});
