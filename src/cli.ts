#!/usr/bin/env node
/**
 * flavor-lite CLI. Zero argument-parsing dependencies: flags are a handful,
 * everything else is configuration or slash commands.
 *
 *   flavor-lite                     interactive REPL
 *   flavor-lite -p "fix the tests"  one-shot run, then exit
 *   flavor-lite --resume <id>       continue a previous session
 */

import { createAgent } from "./host/bootstrap";
import { runRepl } from "./host/repl";
import { renderEvent, yellow, type UiService } from "./host/render";
import { terminalInteractionPlugin } from "./host/interaction";
import { PERMISSION_MODES, type PermissionMode } from "./plugins/permission";
import type { PluginsLoaderService } from "./plugins/plugins";
import type { PluginProfile } from "./plugins/plugins";
import { runEvalSuite } from "./evals";

/** Discover and mount disk plugins (.flavorlite/plugins); failures stay isolated. */
async function initDiskPlugins(handle: ReturnType<typeof createAgent>): Promise<void> {
  const loader = handle.runtime.ctx.tryGet("pluginsLoader") as PluginsLoaderService | undefined;
  if (!loader) return;
  await loader.init();
  for (const status of loader.list()) {
    if (status.status === "error") console.error(yellow(`plugin "${status.name}" failed: ${status.error}`));
  }
}

interface CliArgs {
  model?: string;
  mode?: PermissionMode;
  resume?: string;
  prompt?: string;
  help: boolean;
  doctor: boolean;
  profile?: PluginProfile;
  evalPath?: string;
}

const HELP = `flavor-lite — everything is a plugin

Usage:
  flavor-lite [options]
  flavor-lite -p "your task"      run one task and exit
  flavor-lite doctor              inspect runtime and plugin compatibility
  flavor-lite eval <file|dir>     run repository-task evaluation cases

Options:
  -p, --print <prompt>   one-shot mode: run the prompt, stream output, exit
  -m, --model <ref>      model ref, "provider:model" form
  -M, --mode <mode>      permission mode: ${PERMISSION_MODES.join(" | ")}
  -r, --resume <id>      resume a previous session (default: latest)
  --profile <name>       plugin profile: minimal | coding | full
  -h, --help             show this help

Config sources (low → high): ~/.flavorlite/config.json, .flavorlite/flavor.json,
environment (.env supported), CLI flags. See .env.example for API keys.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, doctor: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "-p":
      case "--print":
        args.prompt = next();
        break;
      case "-m":
      case "--model":
        args.model = next();
        break;
      case "-M":
      case "--mode": {
        const value = next();
        if (!(PERMISSION_MODES as readonly string[]).includes(value ?? "")) {
          throw new Error(`invalid --mode "${value}" (available: ${PERMISSION_MODES.join(", ")})`);
        }
        args.mode = value as PermissionMode;
        break;
      }
      case "-r":
      case "--resume":
        args.resume = next() ?? "latest";
        break;
      case "doctor":
      case "--doctor":
        args.doctor = true;
        break;
      case "eval":
        args.evalPath = next() ?? "evals";
        break;
      case "--profile": {
        const value = next();
        if (!(["minimal", "coding", "full"] as string[]).includes(value ?? "")) {
          throw new Error(`invalid --profile "${value}" (available: minimal, coding, full)`);
        }
        args.profile = value as PluginProfile;
        break;
      }
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option "${flag}" (see --help)`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(yellow(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  const overrides = {
    ...(args.model ? { model: args.model } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
  };

  if (args.doctor) {
    const handle = createAgent({ config: overrides, requireProvider: false });
    try {
      await initDiskPlugins(handle);
      const loader = handle.runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
      const report = await loader.doctor();
      console.log(
        [
          `flavor doctor: ${report.ok ? "OK" : "FAILED"}`,
          `profile=${report.profile} node=${report.node} platform=${report.platform}`,
          `plugins: ${report.loaded} loaded, ${report.unloaded} unloaded, ${report.errors} errors`,
          ...report.issues.map((issue) => `${issue.level.toUpperCase()} ${issue.code}${issue.plugin ? ` [${issue.plugin}]` : ""}: ${issue.message}`),
        ].join("\n"),
      );
      if (!report.ok) process.exitCode = 1;
    } finally {
      await handle.dispose();
    }
    return;
  }

  if (args.evalPath) {
    const suite = await runEvalSuite(args.evalPath, { config: overrides });
    for (const result of suite.results) {
      console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} ${result.durationMs}ms tools=${result.toolCalls} errors=${result.toolErrors} tokens=${result.inputTokens + result.outputTokens}${result.error ? ` error=${result.error}` : ""}`);
    }
    console.log(`eval pass rate: ${(suite.passRate * 100).toFixed(1)}% (${suite.durationMs}ms)`);
    if (!suite.passed) process.exitCode = 1;
    return;
  }

  if (args.prompt) {
    // One-shot: same plugin stack, one turn, no REPL chrome.
    const handle = createAgent({ config: overrides });
    handle.runtime.use(terminalInteractionPlugin);
    try {
      await initDiskPlugins(handle);
      const sessions = handle.runtime.ctx.get("session") as import("./plugins/session").SessionService;
      const resumeId =
        args.resume === undefined ? undefined : args.resume === "latest" ? await sessions.latest() : args.resume;
      const session = resumeId ? await sessions.open(resumeId) : undefined;
      // A UI plugin may take over rendering (same seam as the REPL).
      const ui = handle.runtime.ctx.tryGet("ui") as UiService | undefined;
      for await (const event of handle.run({ input: args.prompt, ...(session ? { session } : {}) })) {
        if (ui) ui.render(event);
        else renderEvent(event);
      }
    } finally {
      await handle.dispose();
    }
    return;
  }

  const handle = createAgent({ config: overrides });
  const resumeId = args.resume === undefined ? undefined : args.resume === "latest" ? "__latest__" : args.resume;
  if (resumeId === "__latest__") {
    const sessions = handle.runtime.ctx.get("session") as import("./plugins/session").SessionService;
    const latest = await sessions.latest();
    await runRepl(handle, latest ? { resume: latest } : {});
  } else {
    await runRepl(handle, resumeId ? { resume: resumeId } : {});
  }
}

main().catch((error) => {
  console.error(yellow(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
