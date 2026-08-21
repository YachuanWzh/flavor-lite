import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createAgent } from "../host/bootstrap";
import type { FlavorConfig } from "../host/config";
import type { AgentEvent } from "../plugins/loop";
import type { PluginsLoaderService } from "../plugins/plugins";

export interface EvalCheck {
  command: string;
  timeoutMs?: number;
}

export interface EvalCase {
  id: string;
  prompt: string;
  fixture: string;
  checks: EvalCheck[];
  maxIterations?: number;
  maxToolErrors?: number;
  maxDurationMs?: number;
}

export interface EvalResult {
  schemaVersion: 1;
  id: string;
  passed: boolean;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  checks: Array<{ command: string; passed: boolean; code: number | string | null; output: string }>;
  error?: string;
  at: string;
}

export interface EvalSuiteResult {
  passed: boolean;
  results: EvalResult[];
  passRate: number;
  durationMs: number;
}

export async function runEvalSuite(
  inputPath: string,
  options: { cwd?: string; config?: FlavorConfig; keepWorkspaces?: boolean } = {},
): Promise<EvalSuiteResult> {
  const cwd = options.cwd ?? process.cwd();
  const cases = await loadCases(isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath));
  const started = Date.now();
  const results: EvalResult[] = [];
  for (const entry of cases) results.push(await runCase(entry.case, entry.baseDir, cwd, options));
  const reportPath = join(cwd, ".flavorlite", "evals", "results.jsonl");
  await mkdir(dirname(reportPath), { recursive: true });
  if (results.length > 0) await appendFile(reportPath, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf-8");
  const passed = results.filter((result) => result.passed).length;
  return {
    passed: passed === results.length && results.length > 0,
    results,
    passRate: results.length === 0 ? 0 : passed / results.length,
    durationMs: Date.now() - started,
  };
}

async function loadCases(path: string): Promise<Array<{ case: EvalCase; baseDir: string }>> {
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as EvalCase | EvalCase[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({ case: validateCase(entry), baseDir: dirname(path) }));
  }
  const names = (await readdir(path)).filter((name) => name.endsWith(".json")).sort();
  const result: Array<{ case: EvalCase; baseDir: string }> = [];
  for (const name of names) result.push(...await loadCases(join(path, name)));
  return result;
}

function validateCase(value: EvalCase): EvalCase {
  if (!value || typeof value.id !== "string" || typeof value.prompt !== "string" || typeof value.fixture !== "string") {
    throw new Error("invalid eval case: id, prompt and fixture are required strings");
  }
  if (!Array.isArray(value.checks) || value.checks.some((check) => typeof check.command !== "string")) {
    throw new Error(`invalid eval case "${value.id}": checks must be command objects`);
  }
  return value;
}

async function runCase(
  test: EvalCase,
  baseDir: string,
  reportCwd: string,
  options: { config?: FlavorConfig; keepWorkspaces?: boolean },
): Promise<EvalResult> {
  const workspace = await mkdtemp(join(tmpdir(), `flavor-eval-${safeName(test.id)}-`));
  const started = Date.now();
  let iterations = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;
  let timedOut = false;
  const checks: EvalResult["checks"] = [];
  let handle: ReturnType<typeof createAgent> | undefined;
  try {
    await cp(resolve(baseDir, test.fixture), workspace, { recursive: true });
    handle = createAgent({ cwd: workspace, config: { ...options.config, mode: "bypass" } });
    const loader = handle.runtime.ctx.tryGet("pluginsLoader") as PluginsLoaderService | undefined;
    await loader?.init();
    const aborter = new AbortController();
    const timer = test.maxDurationMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      aborter.abort();
    }, test.maxDurationMs);
    try {
      for await (const event of handle.run({ input: test.prompt, maxIterations: test.maxIterations ?? 30, signal: aborter.signal })) {
        collect(event);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) throw new Error(`eval exceeded maxDurationMs=${test.maxDurationMs}`);
    for (const check of test.checks) {
      const result = await runCommand(check.command, workspace, check.timeoutMs ?? 120_000);
      checks.push({ command: check.command, passed: result.code === 0, code: result.code, output: `${result.stdout}\n${result.stderr}`.trim().slice(-8_000) });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await handle?.dispose().catch(() => {});
    if (!options.keepWorkspaces) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
  const durationMs = Date.now() - started;
  const passed = !error
    && checks.every((check) => check.passed)
    && toolErrors <= (test.maxToolErrors ?? 0)
    && durationMs <= (test.maxDurationMs ?? Number.POSITIVE_INFINITY);
  return {
    schemaVersion: 1,
    id: test.id,
    passed,
    durationMs,
    iterations,
    toolCalls,
    toolErrors,
    inputTokens,
    outputTokens,
    checks,
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
  };

  function collect(event: AgentEvent): void {
    if (event.type === "turn_start") iterations = Math.max(iterations, event.iteration);
    if (event.type === "tool_end") {
      toolCalls += 1;
      if (event.isError) toolErrors += 1;
    }
    if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    }
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | string | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const shell = process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { file: "/bin/sh", args: ["-lc", command] };
    const child = spawn(shell.file, shell.args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.on("error", (caught) => { clearTimeout(timer); resolvePromise({ code: "spawn", stdout, stderr: `${stderr}\n${caught.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "case";
}
