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
import { renderEvent, yellow } from "./host/render";
import { TerminalInteraction } from "./host/interaction";
import { PERMISSION_MODES, type PermissionMode } from "./plugins/permission";

interface CliArgs {
  model?: string;
  mode?: PermissionMode;
  resume?: string;
  prompt?: string;
  help: boolean;
}

const HELP = `flavor-lite — everything is a plugin

Usage:
  flavor-lite [options]
  flavor-lite -p "your task"      run one task and exit

Options:
  -p, --print <prompt>   one-shot mode: run the prompt, stream output, exit
  -m, --model <ref>      model ref, "provider:model" form
  -M, --mode <mode>      permission mode: ${PERMISSION_MODES.join(" | ")}
  -r, --resume <id>      resume a previous session (default: latest)
  -h, --help             show this help

Config sources (low → high): ~/.flavor/config.json, .flavor/flavor.json,
environment (.env supported), CLI flags. See .env.example for API keys.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
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
  };

  if (args.prompt) {
    // One-shot: same plugin stack, one turn, no REPL chrome.
    const handle = createAgent({
      config: overrides,
      interaction: new TerminalInteraction(),
    });
    try {
      const sessions = handle.runtime.ctx.get("session") as import("./plugins/session").SessionService;
      const resumeId =
        args.resume === undefined ? undefined : args.resume === "latest" ? await sessions.latest() : args.resume;
      const session = resumeId ? await sessions.open(resumeId) : undefined;
      for await (const event of handle.run({ input: args.prompt, ...(session ? { session } : {}) })) {
        renderEvent(event);
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
