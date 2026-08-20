import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { sessionPlugin, type SessionService } from "../src/plugins/session";
import { llmPlugin } from "../src/plugins/llm";
import type { ModelAdapter } from "../src/plugins/llm/types";
import { telemetryPlugin, type TelemetryService } from "../src/plugins/telemetry";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { LoopAfterRun } from "../src/plugins/loop";
import {
  analyzeRun,
  canonicalize,
  detectContradictions,
  detectFlipFlopEdits,
  detectIgnoredFailures,
  detectRedundantExploration,
  detectRepeatWindows,
  detectResultMisread,
  detectUngroundedClaims,
  extractTrace,
  parseJudgeReply,
  scoreFindings,
  toolCallHash,
  verdictFor,
} from "../.flavorlite/plugins/hallucination-detector/analyzer.js";

/** The plugin under test is loaded the way a user loads it: through the
 * plugins loader from the real .flavorlite/plugins/ directory (copied into
 * an isolated temp root so other disk plugins stay out). */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/hallucination-detector", import.meta.url));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type Msg = Record<string, unknown>;

function user(content: string): Msg {
  return { role: "user", content };
}
function assistant(content: string, toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>): Msg {
  return toolCalls ? { role: "assistant", content, toolCalls } : { role: "assistant", content };
}
function tool(id: string, name: string, content: string, isError = false): Msg {
  return { role: "tool", toolCallId: id, name, content, ...(isError ? { isError: true } : {}) };
}

async function copyDir(source: string, targetRoot: string): Promise<string> {
  const name = source.split(/[\\/]/).pop() as string;
  const target = join(targetRoot, name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    await writeFile(join(target, file), await readFile(join(source, file), "utf-8"));
  }
  return target;
}

function judgeAdapter(reply: string): ModelAdapter {
  return {
    type: "fake",
    async *stream() {
      yield { type: "text_delta", text: reply };
      yield { type: "done", stopReason: "end" as const };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pure analyzer engine                                                */
/* ------------------------------------------------------------------ */

describe("hallucination analyzer: call hashing", () => {
  it("hashes identical tool+args the same regardless of key order", () => {
    const a = toolCallHash({ id: "1", name: "Read", args: { path: "a.ts", offset: 1 } });
    const b = toolCallHash({ id: "2", name: "Read", args: { offset: 1, path: "a.ts" } });
    expect(a).toBe(b);
  });

  it("hashes different args and tools differently", () => {
    const base = toolCallHash({ id: "1", name: "Read", args: { path: "a.ts" } });
    expect(toolCallHash({ id: "2", name: "Read", args: { path: "b.ts" } })).not.toBe(base);
    expect(toolCallHash({ id: "3", name: "Glob", args: { path: "a.ts" } })).not.toBe(base);
  });

  it("canonicalizes nested objects recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toEqual({
      a: { c: [1, { y: 2, z: 1 }], d: 2 },
      b: 1,
    });
  });
});

describe("hallucination analyzer: repeat-window detection", () => {
  const hash = toolCallHash({ id: "x", name: "Grep", args: { regex: "foo" } });
  const other = toolCallHash({ id: "y", name: "Grep", args: { regex: "bar" } });

  it("flags a hash reaching the threshold inside the window", () => {
    expect(detectRepeatWindows(Array.from({ length: 12 }, () => hash))).toEqual([{ hash, count: 12 }]);
  });

  it("stays quiet below the threshold", () => {
    expect(detectRepeatWindows(Array.from({ length: 9 }, () => hash))).toEqual([]);
  });

  it("respects the sliding window when calls are interleaved", () => {
    // 18 alternating calls: any 20-window holds only 9 of each hash.
    const interleaved = Array.from({ length: 18 }, (_, index) => (index % 2 === 0 ? hash : other));
    expect(detectRepeatWindows(interleaved)).toEqual([]);
  });

  it("supports custom window/threshold config", () => {
    const calls = Array.from({ length: 4 }, () => hash);
    expect(detectRepeatWindows(calls, { windowSize: 5, threshold: 4 })).toEqual([{ hash, count: 4 }]);
    expect(detectRepeatWindows(calls, { windowSize: 5, threshold: 5 })).toEqual([]);
  });
});

describe("hallucination analyzer: trace extraction", () => {
  it("pairs tool calls with their results and captures the final answer", () => {
    const trace = extractTrace([
      user("fix the bug"),
      assistant("checking", [{ id: "t1", name: "Read", args: { path: "src/a.ts" } }]),
      tool("t1", "Read", "content here"),
      assistant("Fixed src/a.ts."),
    ]);
    expect(trace.userRequests).toEqual(["fix the bug"]);
    expect(trace.toolTrace).toHaveLength(1);
    expect(trace.toolTrace[0]!.result).toBe("content here");
    expect(trace.toolTrace[0]!.isError).toBe(false);
    expect(trace.finalAnswer).toBe("Fixed src/a.ts.");
  });

  it("counts steering messages and compaction markers", () => {
    const trace = extractTrace([
      user("do it"),
      user("[steering] be brief"),
      user("[system] Earlier conversation (12 messages before this point) was compacted to fit the context window; 800 characters were dropped."),
      assistant("done"),
    ]);
    expect(trace.userRequests).toEqual(["do it"]);
    expect(trace.steeringCount).toBe(1);
    expect(trace.compacted).toBe(true);
  });
});

describe("hallucination analyzer: tool-execution rules", () => {
  it("detects flip-flop edits (same file rewritten with alternating content)", () => {
    const trace = extractTrace([
      assistant("", [{ id: "w1", name: "Write", args: { path: "a.txt", content: "v1" } }]),
      tool("w1", "Write", "Wrote 2 characters to a.txt"),
      assistant("", [{ id: "w2", name: "Write", args: { path: "a.txt", content: "v2" } }]),
      tool("w2", "Write", "Wrote 2 characters to a.txt"),
      assistant("", [{ id: "w3", name: "Write", args: { path: "a.txt", content: "v3" } }]),
      tool("w3", "Write", "Wrote 2 characters to a.txt"),
    ]);
    const findings = detectFlipFlopEdits(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "flip-flop-edit", stage: "tool-execution" });
    expect(findings[0]!.data?.flips).toBe(2);
  });

  it("detects a failure retried verbatim", () => {
    const trace = extractTrace([
      assistant("", [{ id: "g1", name: "Grep", args: { regex: "nope" } }]),
      tool("g1", "Grep", "No matches found."),
      assistant("", [{ id: "g2", name: "Grep", args: { regex: "nope" } }]),
      tool("g2", "Grep", "No matches found."),
    ]);
    const findings = detectIgnoredFailures(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("failure-ignored");
  });

  it("detects claims of success over an actual failure (result misread)", () => {
    const trace = extractTrace([
      user("run the tests"),
      assistant("", [{ id: "t1", name: "Shell", args: { command: "npm test" } }]),
      tool("t1", "Shell", "Error: no such file or directory", true),
      assistant("The Shell command succeeded and all tests passed."),
    ]);
    const findings = detectResultMisread(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "result-misread", severity: "high" });
  });

  it("does not flag success claims when the tool actually succeeded", () => {
    const trace = extractTrace([
      assistant("", [{ id: "t1", name: "Shell", args: { command: "npm test" } }]),
      tool("t1", "Shell", "all tests passed"),
      assistant("The Shell command succeeded."),
    ]);
    expect(detectResultMisread(trace)).toHaveLength(0);
  });
});

describe("hallucination analyzer: reasoning & process rules", () => {
  it("detects self-contradicting statements", () => {
    const trace = extractTrace([
      assistant("There are no tests in this repository."),
      assistant("Actually I found 3 tests in this repository and ran them."),
    ]);
    const findings = detectContradictions(trace);
    expect(findings.some((finding) => finding.rule === "contradiction")).toBe(true);
  });

  it("detects redundant exploration (same read 3x in a row)", () => {
    const read = { name: "Read", args: { path: "src/a.ts" } };
    const trace = extractTrace([
      assistant("", [{ id: "r1", ...read }]),
      tool("r1", "Read", "content"),
      assistant("", [{ id: "r2", ...read }]),
      tool("r2", "Read", "content"),
      assistant("", [{ id: "r3", ...read }]),
      tool("r3", "Read", "content"),
    ]);
    const findings = detectRedundantExploration(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "redundant-exploration", stage: "process" });
  });

  it("breaks exploration runs at a write call", () => {
    const read = { name: "Read", args: { path: "src/a.ts" } };
    const trace = extractTrace([
      assistant("", [{ id: "r1", ...read }]),
      tool("r1", "Read", "content"),
      assistant("", [{ id: "r2", ...read }]),
      tool("r2", "Read", "content"),
      assistant("", [{ id: "w1", name: "Write", args: { path: "src/a.ts", content: "x" } }]),
      tool("w1", "Write", "Wrote 1 characters to src/a.ts"),
      assistant("", [{ id: "r3", ...read }]),
      tool("r3", "Read", "content x"),
    ]);
    expect(detectRedundantExploration(trace)).toHaveLength(0);
  });
});

describe("hallucination analyzer: output grounding", () => {
  it("flags files mentioned in the answer without evidence in the trace", () => {
    const trace = extractTrace([
      user("fix it"),
      assistant("", [{ id: "t1", name: "Read", args: { path: "src/real.ts" } }]),
      tool("t1", "Read", "some content"),
      assistant("Updated src/real.ts and also src/ghost.ts."),
    ]);
    const findings = detectUngroundedClaims(trace);
    const files = findings.filter((finding) => finding.rule === "ungrounded-file");
    expect(files).toHaveLength(1);
    expect(files[0]!.data?.claim).toBe("src/ghost.ts");
  });

  it("flags commands claimed but never executed via Shell", () => {
    const trace = extractTrace([
      user("test it"),
      assistant("All fixed. I ran `npm test` and everything passed."),
    ]);
    const findings = detectUngroundedClaims(trace);
    expect(findings.some((finding) => finding.rule === "ungrounded-command" && finding.data?.claim === "npm test")).toBe(true);
  });

  it("accepts claims backed by tool evidence", () => {
    const trace = extractTrace([
      assistant("", [{ id: "t1", name: "Shell", args: { command: "npm test" } }]),
      tool("t1", "Shell", "5 passed"),
      assistant("I ran `npm test` and everything passed."),
    ]);
    expect(detectUngroundedClaims(trace)).toHaveLength(0);
  });
});

describe("hallucination analyzer: judge reply parsing & scoring", () => {
  it("parses a fenced strict-JSON judge reply", () => {
    const parsed = parseJudgeReply(
      'Sure! ```json\n{"aligned": false, "score": 2, "issues": [{"stage": "input-planning", "severity": "high", "message": "missed requirement X"}]}\n```',
    );
    expect(parsed).toEqual({
      aligned: false,
      score: 2,
      issues: [{ stage: "input-planning", severity: "high", message: "missed requirement X" }],
    });
  });

  it("normalizes unknown stages/severities and caps scores", () => {
    const parsed = parseJudgeReply('{"aligned": true, "score": 9, "issues": [{"stage": "weird", "severity": "extreme", "message": "m"}]}');
    expect(parsed).toMatchObject({ aligned: true, score: 5, issues: [{ stage: "input-planning", severity: "medium" }] });
  });

  it("rejects garbage replies", () => {
    expect(parseJudgeReply("nonsense")).toBeUndefined();
    expect(parseJudgeReply("")).toBeUndefined();
  });

  it("scores findings and maps verdict thresholds", () => {
    expect(scoreFindings([])).toBe(0);
    expect(verdictFor(0)).toBe("clean");
    expect(verdictFor(10)).toBe("suspect");
    expect(verdictFor(11)).toBe("suspect");
    expect(verdictFor(12)).toBe("likely-hallucinated");
    expect(verdictFor(200)).toBe("likely-hallucinated");
  });

  it("merges judge issues as attributed findings in analyzeRun", () => {
    const trace = extractTrace([user("do X"), assistant("Did X.")]);
    const report = analyzeRun(trace, {
      judge: { aligned: false, score: 1, issues: [{ stage: "input-planning", severity: "high", message: "did Y instead" }] },
    });
    expect(report.findings.some((finding) => finding.rule === "intent-misalignment")).toBe(true);
    expect(report.findings.some((finding) => finding.rule === "judge-finding" && finding.message === "did Y instead")).toBe(true);
  });
});

describe("hallucination analyzer: end-to-end aggregation", () => {
  it("flags a stuck 12-call loop as likely-hallucinated", () => {
    const messages: Msg[] = [user("search for it")];
    for (let index = 0; index < 12; index += 1) {
      messages.push(assistant("", [{ id: `t${index}`, name: "Grep", args: { regex: "foo" } }]));
      messages.push(tool(`t${index}`, "Grep", "No matches found."));
    }
    messages.push(assistant("Nothing to do, finished."));
    const report = analyzeRun(extractTrace(messages));
    const repeat = report.findings.find((finding) => finding.rule === "repeat-window");
    expect(repeat).toBeDefined();
    expect(repeat!.data?.count).toBe(12);
    expect(report.verdict).toBe("likely-hallucinated");
  });

  it("reports a clean run as clean", () => {
    const trace = extractTrace([
      user("read the file"),
      assistant("", [{ id: "t1", name: "Read", args: { path: "src/a.ts" } }]),
      tool("t1", "Read", "export const a = 1;"),
      assistant("The file src/a.ts exports a."),
    ]);
    const report = analyzeRun(trace);
    expect(report.findings).toHaveLength(0);
    expect(report.verdict).toBe("clean");
  });
});

/* ------------------------------------------------------------------ */
/* Disk-loaded plugin integration                                      */
/* ------------------------------------------------------------------ */

describe("hallucination-detector plugin (disk-loaded)", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  async function mount(judgeReply?: string): Promise<void> {
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(commandsPlugin).use(sessionPlugin).use(telemetryPlugin);
    if (judgeReply !== undefined) {
      runtime.use(llmPlugin, { providers: { fake: { adapter: judgeAdapter(judgeReply), defaultModel: "fake-judge" } } });
    }
    runtime.use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-hallucination-"));
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
  function hallucination(): {
    audit: (sessionId?: string) => Promise<Record<string, unknown> | undefined>;
    latest: () => Promise<Record<string, unknown> | undefined>;
    list: () => Promise<Array<Record<string, unknown>>>;
    clear: () => Promise<void>;
    idle: () => Promise<void>;
  } {
    return runtime.ctx.get("hallucination") as never;
  }

  async function fireAfterRun(overrides: Partial<LoopAfterRun> = {}): Promise<void> {
    await hooks().waterfall<LoopAfterRun>("loop/after-run", {
      iterations: 2,
      reason: "finished",
      toolCalls: 1,
      toolErrors: 0,
      steers: 0,
      inputTokens: 10,
      outputTokens: 5,
      ...overrides,
    });
  }

  async function seedHallucinatorySession(): Promise<void> {
    const session = runtime.ctx.get("session") as SessionService;
    const handle = await session.create();
    await handle.append({ role: "user", content: "add a helper to src/helper.ts" } as never);
    await handle.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "Read", args: { path: "src/helper.ts" } }],
    } as never);
    await handle.append({ role: "tool", toolCallId: "t1", name: "Read", content: "export {}" } as never);
    await handle.append({ role: "assistant", content: "Done — I updated src/helper.ts and also src/ghost.ts." } as never);
  }

  it("loads, provides the hallucination service and registers /hallucination", async () => {
    await mount();
    expect(loader.list().find((entry) => entry.name === "hallucination-detector")?.status).toBe("loaded");
    expect(runtime.ctx.tryGet("hallucination")).toBeDefined();
    expect(await commands().execute("/hallucination")).toBe("no hallucination audits recorded yet");
  });

  it("auto-audits after a finished run and persists the report", async () => {
    await mount();
    await seedHallucinatorySession();
    await fireAfterRun();
    await hallucination().idle();

    const reports = await hallucination().list();
    expect(reports).toHaveLength(1);
    const report = reports[0] as { verdict: string; findings: Array<{ rule: string; data?: { claim?: string } }> };
    expect(report.verdict).toBe("suspect");
    const ungrounded = report.findings.find((finding) => finding.rule === "ungrounded-file");
    expect(ungrounded?.data?.claim).toBe("src/ghost.ts");

    // Persisted on disk as JSONL.
    const raw = await readFile(join(dir, ".flavorlite", "hallucination", "reports.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);

    // Mirrored into the telemetry feed.
    const telemetry = runtime.ctx.get("telemetry") as TelemetryService;
    const events = await telemetry.events({ type: "hallucination.audit" });
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe("suspect");
  });

  it("skips the audit when the run did not finish", async () => {
    await mount();
    await seedHallucinatorySession();
    await fireAfterRun({ reason: "aborted" });
    await hallucination().idle();
    expect(await hallucination().list()).toHaveLength(0);
  });

  it("merges the LLM judge verdict into the report (intent dimension)", async () => {
    await mount('```json\n{"aligned": false, "score": 1, "issues": [{"stage": "input-planning", "severity": "high", "message": "touched files the user never asked for"}]}\n```');
    await seedHallucinatorySession();
    await fireAfterRun();
    await hallucination().idle();

    const report = (await hallucination().latest()) as {
      findings: Array<{ rule: string }>;
      stats: { judgeScore: number };
      score: number;
    };
    expect(report.findings.some((finding) => finding.rule === "intent-misalignment")).toBe(true);
    expect(report.findings.some((finding) => finding.rule === "judge-finding")).toBe(true);
    expect(report.stats.judgeScore).toBe(1);
    expect(report.score).toBeGreaterThanOrEqual(24);
  });

  it("/hallucination last formats the latest report, now re-audits, clear empties", async () => {
    await mount();
    await seedHallucinatorySession();
    await fireAfterRun();
    await hallucination().idle();

    const last = await commands().execute("/hallucination last");
    expect(last).toContain("hallucination audit:");
    expect(last).toContain("ungrounded-file");

    const now = await commands().execute("/hallucination now");
    expect(now).toContain("hallucination audit:");
    expect(await hallucination().list()).toHaveLength(2);

    const show = await commands().execute("/hallucination show");
    expect(show?.split("\n")).toHaveLength(2);

    expect(await commands().execute("/hallucination clear")).toContain("cleared");
    expect(await hallucination().list()).toHaveLength(0);
  });
});
