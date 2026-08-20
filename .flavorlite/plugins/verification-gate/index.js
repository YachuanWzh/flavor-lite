import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, extname, relative, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 20_000;

export async function detectVerificationPlan(cwd, options = {}) {
  const mode = options.mode === "full" ? "full" : "quick";
  const changedFiles = Array.isArray(options.changedFiles) ? options.changedFiles : [];
  const configured = Array.isArray(options.commands) ? options.commands : undefined;
  if (configured) return configured.map((command, index) => normalizeConfigured(command, index));

  const packagePath = resolve(cwd, "package.json");
  if (await exists(packagePath)) {
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const npm = (label, args = "") => ({ label, command: `npm run ${label}${args}`, cwd });
    const steps = [];
    if (scripts.typecheck) steps.push(npm("typecheck"));
    if (scripts.lint) steps.push(npm("lint"));
    const changedTests = changedFiles.filter(isTestFile);
    if (scripts.test) {
      if (mode === "quick" && changedTests.length > 0) {
        for (const file of changedTests.slice(0, 5)) {
          steps.push({ label: `test:${basename(file)}`, command: `npm test -- ${quote(file)}`, cwd });
        }
      } else if (mode === "full") {
        steps.push({ label: "test", command: "npm test", cwd });
      }
    }
    if (mode === "full" && scripts.build) steps.push(npm("build"));
    return steps;
  }

  if (await exists(resolve(cwd, "pyproject.toml")) || await exists(resolve(cwd, "pytest.ini"))) {
    return mode === "full"
      ? [{ label: "pytest", command: "python -m pytest", cwd }]
      : [{ label: "pytest", command: changedFiles.filter((file) => /test.*\.py$|_test\.py$/i.test(file)).map(quote).join(" ") || "python -m pytest", cwd }]
        .map((step) => ({ ...step, command: step.command.startsWith("python") ? step.command : `python -m pytest ${step.command}` }));
  }
  if (await exists(resolve(cwd, "go.mod"))) return [{ label: "go test", command: "go test ./...", cwd }];
  if (await exists(resolve(cwd, "Cargo.toml"))) {
    return mode === "full"
      ? [{ label: "cargo test", command: "cargo test", cwd }, { label: "cargo check", command: "cargo check", cwd }]
      : [{ label: "cargo check", command: "cargo check", cwd }];
  }
  return [];
}

function normalizeConfigured(value, index) {
  if (typeof value === "string" && value.trim()) return { label: `custom:${index + 1}`, command: value.trim() };
  if (value && typeof value.command === "string" && value.command.trim()) {
    return { label: String(value.label || `custom:${index + 1}`), command: value.command.trim() };
  }
  throw new Error(`Invalid configured verification command at index ${index}`);
}

export async function runVerificationPlan(plan, options = {}) {
  const results = [];
  for (const step of plan) {
    const result = await runCommand(step, options);
    results.push(result);
    if (result.code !== 0 && options.stopOnFailure !== false) break;
  }
  return results;
}

function runCommand(step, options) {
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT);
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let output = "";
    let settled = false;
    const child = spawn(step.command, {
      cwd: step.cwd ?? options.cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (prefix, chunk) => {
      if (output.length >= maxOutputChars) return;
      output += prefix + chunk.toString("utf8");
      if (output.length > maxOutputChars) output = output.slice(0, maxOutputChars) + "\n…[output truncated]";
    };
    child.stdout.on("data", (chunk) => append("", chunk));
    child.stderr.on("data", (chunk) => append("[stderr] ", chunk));
    const finish = (code, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (note) append("", note);
      resolvePromise({ ...step, code: code ?? -1, durationMs: Date.now() - startedAt, output: output.trim() });
    };
    child.on("error", (error) => finish(-1, error.message));
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1, `\nTimed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();
    if (options.signal) {
      const abort = () => { child.kill("SIGKILL"); finish(-1, "\nAborted"); };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export function formatVerificationReport(results) {
  if (!results.length) return "No verification checks were detected for this project and mode.";
  const failed = results.find((result) => result.code !== 0);
  const lines = [`Verification ${failed ? "FAILED" : "PASSED"} · ${results.length} check${results.length === 1 ? "" : "s"}`];
  for (const result of results) {
    lines.push(`${result.code === 0 ? "✓" : "✗"} ${result.label} · exit ${result.code} · ${result.durationMs}ms`);
    if (result.code !== 0 && result.output) lines.push(indent(result.output));
  }
  return lines.join("\n");
}

export async function toToolResult(run, reportsFailure = () => false) {
  try {
    const content = await run();
    return { content, ...(reportsFailure(content) ? { isError: true } : {}) };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export default {
  name: "verification-gate",
  inject: ["hooks", "tools", "commands"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const changedFiles = new Set();
      const opts = {
        timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputChars: positiveInt(config.maxOutputChars, DEFAULT_MAX_OUTPUT),
        stopOnFailure: config.stopOnFailure !== false,
        commands: Array.isArray(config.commands) ? config.commands : undefined,
      };
      const verify = async (mode, signal) => {
        const plan = await detectVerificationPlan(ctx.cwd, { mode, changedFiles: [...changedFiles], commands: opts.commands });
        const results = await runVerificationPlan(plan, { ...opts, cwd: ctx.cwd, signal });
        if (results.length > 0 && results.every((result) => result.code === 0)) changedFiles.clear();
        return formatVerificationReport(results);
      };
      const disposers = [];
      disposers.push(ctx.get("tools").register({
        name: "verify_changes",
        description: "Run repository-native verification checks after code changes. mode=quick runs focused checks; mode=full includes the full test/build suite.",
        category: "shell",
        inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["quick", "full"] } } },
        execute(args, execCtx) {
          return toToolResult(
            () => verify(args.mode === "full" ? "full" : "quick", execCtx.signal),
            (content) => content.includes("FAILED"),
          );
        },
      }));
      disposers.push(ctx.get("commands").register({
        name: "verify", description: "Run detected verification checks (/verify quick|full)",
        async run(args) {
          const result = await toToolResult(() => verify(args.trim() === "full" ? "full" : "quick"));
          return result.isError ? `Verification error: ${result.content}` : result.content;
        },
      }));
      disposers.push(ctx.get("hooks").hook("tools/after-call", async (event, next) => {
        if (!event.result.isError) {
          const tool = ctx.get("tools").get(event.toolCall.name);
          if (tool?.category === "write") {
            const path = event.args.path ?? event.args.file_path ?? event.args.filePath;
            if (typeof path === "string") changedFiles.add(relative(ctx.cwd, resolve(ctx.cwd, path)).replaceAll("\\", "/"));
            if (Array.isArray(event.args.operations)) for (const op of event.args.operations) if (typeof op?.path === "string") changedFiles.add(op.path.replaceAll("\\", "/"));
          }
        }
        return next(event);
      }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        event.sections.push({ name: "verification-gate", content: "After changing code, call verify_changes. Use quick during iteration and full before declaring a non-trivial task complete. Never claim checks passed without the tool result." });
        return next(event);
      }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "verification-gate.install");
  },
};

function isTestFile(file) { const normalized = file.replaceAll("\\", "/"); return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(normalized); }
function quote(value) { return `"${String(value).replaceAll('"', '\\"')}"`; }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function indent(text) { return text.split("\n").slice(-80).map((line) => `  ${line}`).join("\n"); }
