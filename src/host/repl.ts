/**
 * The interactive host: a readline REPL that drives the agent handle.
 * While a turn is running, further input becomes steering messages
 * (pi-style); Ctrl+C aborts the current turn, not the process.
 */

import * as readline from "node:readline";
import type { AgentHandle } from "./bootstrap";
import { bold, dim, renderEvent, yellow } from "./render";
import { TerminalInteraction } from "./interaction";
import type { LlmService } from "../plugins/llm";
import type { CommandsService } from "../plugins/commands";
import { PERMISSION_MODES, type PermissionService, type PermissionMode } from "../plugins/permission";
import type { SessionHandle, SessionService } from "../plugins/session";

export interface ReplOptions {
  /** Session id to resume. */
  resume?: string;
}

export async function runRepl(handle: AgentHandle, options: ReplOptions = {}): Promise<void> {
  const ctx = handle.runtime.ctx;
  const commands = ctx.get("commands") as CommandsService;
  const llm = ctx.get("llm") as LlmService;
  const permission = ctx.get("permission") as PermissionService;
  const sessions = ctx.get("session") as SessionService;

  let session: SessionHandle = options.resume
    ? await sessions.open(options.resume)
    : await sessions.create({ model: llm.defaultRef() });
  const sessionRef = {
    getSession: () => session,
    setSession: (next: SessionHandle) => {
      session = next;
    },
  };
  registerHostCommands(handle, sessionRef);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
  const interaction = new TerminalInteraction({
    onBeforeAsk: () => rl.pause(),
    onAfterAsk: () => rl.resume(),
  });
  ctx.provide("interaction", interaction);

  printBanner(handle, session, permission.mode());

  let busy = false;
  let aborter: AbortController | undefined;
  let closing = false;

  const showPrompt = () => {
    if (busy) return; // no prompt while a turn streams
    const mode = permission.mode();
    const tag = mode === "default" ? "" : ` [${mode}]`;
    rl.setPrompt(`›${tag} `);
    rl.prompt();
  };

  rl.on("SIGINT", () => {
    if (busy && aborter) {
      aborter.abort(); // ends the current turn; second Ctrl+C while idle exits
      return;
    }
    console.log(dim("\nbye"));
    rl.close();
  });

  rl.on("close", async () => {
    if (closing) return;
    closing = true;
    await handle.dispose();
    process.exit(0);
  });

  rl.on("line", (rawLine) => {
    const line = rawLine.trim();
    if (busy) {
      if (line) {
        handle.steer(line);
        console.log(dim("  steered: injected before the next model request"));
      }
      return;
    }
    if (!line) {
      showPrompt();
      return;
    }
    if (line === "/exit" || line === "/quit") {
      rl.close();
      return;
    }

    void (async () => {
      if (line.startsWith("/")) {
        try {
          const output = await commands.execute(line);
          if (output) console.log(output);
        } catch (error) {
          console.log(yellow(`error: ${error instanceof Error ? error.message : String(error)}`));
        }
        showPrompt();
        return;
      }

      busy = true;
      aborter = new AbortController();
      try {
        for await (const event of handle.run({ input: line, session: sessionRef.getSession(), signal: aborter.signal })) {
          renderEvent(event);
        }
      } catch (error) {
        console.log(yellow(`error: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        busy = false;
        aborter = undefined;
        showPrompt();
      }
    })();
  });

  showPrompt();
}

function printBanner(handle: AgentHandle, session: SessionHandle, mode: PermissionMode): void {
  const llm = handle.runtime.ctx.get("llm") as LlmService;
  console.log(bold("flavor-lite") + dim(" — everything is a plugin"));
  console.log(dim(`model ${llm.defaultRef() ?? "unset"} · mode ${mode} · session ${session.id}`));
  console.log(dim("type /help for commands; input while running becomes steering") + "\n");
}

/** Host-owned commands; feature plugins register their own (/init, ...). */
function registerHostCommands(
  handle: AgentHandle,
  sessionRef: { getSession(): SessionHandle; setSession(session: SessionHandle): void },
): void {
  const ctx = handle.runtime.ctx;
  const commands = ctx.get("commands") as CommandsService;
  const llm = ctx.get("llm") as LlmService;
  const permission = ctx.get("permission") as PermissionService;
  const sessions = ctx.get("session") as SessionService;

  commands.register({
    name: "help",
    description: "List all commands",
    run() {
      return commands.list().map((command) => `  /${command.name.padEnd(12)} ${command.description}`).join("\n");
    },
  });

  commands.register({
    name: "model",
    description: "Show or switch the model (/model provider:model)",
    run(args) {
      if (!args) return `current model: ${llm.defaultRef() ?? "unset"} (providers: ${llm.providers().join(", ")})`;
      try {
        llm.setDefaultRef(args);
        return `model set to ${args}`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  commands.register({
    name: "permissions",
    description: `Show or set mode (${PERMISSION_MODES.join("|")})`,
    run(args) {
      if (!args) return `current mode: ${permission.mode()}`;
      if (!(PERMISSION_MODES as readonly string[]).includes(args)) {
        return `unknown mode "${args}" (available: ${PERMISSION_MODES.join(", ")})`;
      }
      permission.setMode(args as PermissionMode);
      return `permission mode set to ${args}`;
    },
  });

  commands.register({
    name: "sessions",
    description: "List recent sessions",
    async run() {
      const infos = await sessions.list();
      if (infos.length === 0) return "no sessions yet";
      return infos
        .slice(0, 10)
        .map((info) => `  ${info.id}  ${info.messageCount} msgs  ${info.title ?? "(untitled)"}`)
        .join("\n");
    },
  });

  commands.register({
    name: "resume",
    description: "Resume a session by id (/resume <id>)",
    async run(args) {
      const id = args || (await sessions.latest());
      if (!id) return "no session to resume";
      sessionRef.setSession(await sessions.open(id));
      return `resumed session ${id}`;
    },
  });

  commands.register({
    name: "new",
    description: "Start a fresh session",
    async run() {
      sessionRef.setSession(await sessions.create({ model: llm.defaultRef() }));
      return `new session ${sessionRef.getSession().id}`;
    },
  });
}
