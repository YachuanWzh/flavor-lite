/**
 * Shell tool: run a command in the workspace with a timeout and truncated
 * output. Non-interactive by design; interactive commands fail fast.
 *
 * Windows notes: the command is handed to PowerShell 7 (pwsh) when installed,
 * falling back to Windows PowerShell 5.1 (powershell.exe) and then cmd.exe.
 * Both PowerShell variants accept CRT-style `\"` quoting, so Node's default
 * argument quoting works for them; cmd.exe needs the command verbatim (Node's
 * automatic quoting would escape embedded double quotes into `\"`, which cmd
 * does not understand, breaking e.g. `node -e "..."`). Timeouts and aborts
 * kill the whole process tree — killing only the shell would leave orphaned
 * descendants holding the stdio pipes open, so 'close' would never fire.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { definePlugin } from "../../../kernel";
import type { Plugin } from "../../../kernel/types";
import type { PromptAssemble } from "../../prompt";
import { truncateOutput } from "./paths";
import type { Tool } from "../registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const SHELL_PROBE_TIMEOUT_MS = 5_000;

type WindowsShell = "pwsh" | "powershell" | "cmd";

let cachedWindowsShell: WindowsShell | undefined;

/** Probe pwsh, then powershell.exe; cache the best available for the process. */
function resolveWindowsShell(): Promise<WindowsShell> {
  if (cachedWindowsShell !== undefined) return Promise.resolve(cachedWindowsShell);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (shell: WindowsShell) => {
      if (settled) return;
      settled = true;
      cachedWindowsShell = shell;
      resolve(shell);
    };
    // where.exe should return instantly; each probe gets a hang guard.
    const probe = (name: string, onResult: (found: boolean) => void) => {
      const child = spawn("where.exe", [name], { stdio: "ignore", windowsHide: true });
      let done = false;
      const finish = (found: boolean) => {
        if (done) return;
        done = true;
        onResult(found);
      };
      const guard = setTimeout(() => finish(false), SHELL_PROBE_TIMEOUT_MS);
      guard.unref?.();
      child.on("error", () => {
        clearTimeout(guard);
        finish(false);
      });
      child.on("close", (code) => {
        clearTimeout(guard);
        finish(code === 0);
      });
    };
    probe("pwsh", (pwshFound) => {
      if (pwshFound) return settle("pwsh");
      probe("powershell", (psFound) => settle(psFound ? "powershell" : "cmd"));
    });
  });
}

export const shellTool: Tool = {
  name: "Shell",
  category: "shell",
  description:
    "Execute a shell command in the workspace directory and return combined output with the exit code. Non-interactive; long-running commands are killed after the timeout. Keep commands scoped and auditable.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute" },
      timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const command = typeof args.command === "string" ? args.command : undefined;
    if (!command) return { content: "Missing required argument: command", isError: true };
    const timeout = typeof args.timeoutMs === "number" ? Math.min(args.timeoutMs, 600_000) : DEFAULT_TIMEOUT_MS;

    const isWindows = process.platform === "win32";
    // Prefer PowerShell 7 (pwsh), then Windows PowerShell 5.1
    // (powershell.exe), then cmd.exe. Detection is probed once and cached for
    // the process.
    const shell = isWindows ? await resolveWindowsShell() : null;
    const shellArgs: [string, string[]] = !isWindows
      ? [process.env.SHELL ?? "/bin/sh", ["-c", command]]
      : shell === "pwsh"
        ? ["pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]]
        : shell === "powershell"
          ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]]
          : ["cmd.exe", ["/d", "/s", "/c", command]];
    // Verbatim args only for cmd.exe (see module note); both PowerShell
    // variants accept the `\"` quoting Node's default Windows argument quoting
    // produces. A detached process group on POSIX so the kill below reaches
    // every descendant via kill(-pid).
    const spawnOptions = !isWindows
      ? { detached: true }
      : shell === "cmd"
        ? { windowsVerbatimArguments: true }
        : {};

    return new Promise((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let killNote: string | undefined;

      const child = spawn(shellArgs[0], shellArgs[1], {
        cwd: ctx.cwd,
        windowsHide: true,
        env: process.env,
        ...spawnOptions,
      });

      const timer = setTimeout(() => killTree(`[killed after ${timeout}ms timeout]`), timeout);

      // Kill the whole tree, then settle on a grace timer in case orphaned
      // descendants keep the stdio pipes open and 'close' never fires.
      const killTree = (note: string) => {
        if (settled) return;
        killNote = note;
        if (child.pid === undefined) {
          try {
            child.kill("SIGKILL");
          } catch {
            // not spawned yet / already gone
          }
        } else if (isWindows) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }
        }
        graceTimer = setTimeout(() => finish(null, note), 2_000);
        graceTimer.unref?.();
      };

      // The loop aborts through the turn signal; spawn's built-in signal
      // support would only kill cmd.exe, so drive the tree kill ourselves.
      const onAbort = () => killTree("[aborted by user]");
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (code: number | null, note?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trim());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
        if (note) parts.push(note);
        parts.push(`[exit code: ${code ?? "unknown"}]`);
        const isError = code !== 0;
        resolvePromise({ content: truncateOutput(parts.join("\n\n") || "(no output)", MAX_OUTPUT_CHARS), isError });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_OUTPUT_CHARS * 2) stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT_CHARS * 2) stderr += chunk.toString("utf-8");
      });
      child.on("error", (error) => finish(null, `[spawn error] ${error.message}`));
      child.on("close", (code) => finish(code, killNote));
    });
  },
};

/** Platform-aware shell note; only exists while the shell tool is mounted. */
function shellSection(): string {
  return platform() === "win32"
    ? "Shell commands run through PowerShell 7 (pwsh) on Windows when available, falling back to Windows PowerShell 5.1 (powershell.exe) then cmd.exe. Prefer simple, portable commands."
    : "Shell commands run through $SHELL (POSIX). The tool is non-interactive: commands that wait for input will fail.";
}

export const shellToolPlugin: Plugin = definePlugin({
  name: "tool:shell",
  inject: ["hooks", "tools"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposeTool = ctx.get("tools").register(shellTool);
      const disposeSection = ctx.get("hooks").hook<PromptAssemble>("prompt/assemble", async (event, next) => {
        event.sections.push({ name: "shell", content: shellSection() });
        return next(event);
      });
      return () => {
        disposeSection();
        disposeTool();
      };
    }, "tool:shell.install");
  },
});
