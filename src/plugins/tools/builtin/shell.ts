/**
 * Shell tool: run a command in the workspace with a timeout and truncated
 * output. Non-interactive by design; interactive commands fail fast.
 */

import { spawn } from "node:child_process";
import { definePlugin } from "../../../kernel";
import type { Plugin } from "../../../kernel/types";
import { truncateOutput } from "./paths";
import type { Tool } from "../registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

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
  execute(args, ctx) {
    const command = typeof args.command === "string" ? args.command : undefined;
    if (!command) return Promise.resolve({ content: "Missing required argument: command", isError: true });
    const timeout = typeof args.timeoutMs === "number" ? Math.min(args.timeoutMs, 600_000) : DEFAULT_TIMEOUT_MS;

    const isWindows = process.platform === "win32";
    const shellArgs: [string, string[]] = isWindows
      ? ["cmd.exe", ["/d", "/s", "/c", command]]
      : [process.env.SHELL ?? "/bin/sh", ["-c", command]];

    return new Promise((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const child = spawn(shellArgs[0], shellArgs[1], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        windowsHide: true,
        env: process.env,
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeout);

      const finish = (code: number | null, note?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
      child.on("close", (code) => {
        const timedOut = code === null && Date.now() >= timeout - 50;
        finish(code, timedOut ? `[killed after ${timeout}ms timeout]` : undefined);
      });
    });
  },
};

export const shellToolPlugin: Plugin = definePlugin({
  name: "tool:shell",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(shellTool), "tool:shell.register");
  },
});
