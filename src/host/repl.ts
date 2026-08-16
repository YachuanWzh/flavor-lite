/**
 * The interactive host: a readline REPL that drives the agent handle.
 * While a turn is running, further input becomes steering messages
 * (pi-style); Ctrl+C aborts the current turn, not the process.
 */

import * as readline from "node:readline";
import type { AgentHandle } from "./bootstrap";
import { bold, dim, renderEvent, yellow, type UiBannerInfo, type UiService } from "./render";
import { version } from "../../package.json";
import { terminalInteractionPlugin } from "./interaction";
import { ReplCompletions } from "./completions";
import type { LlmService } from "../plugins/llm";
import type { CommandsService } from "../plugins/commands";
import type { PluginsLoaderService } from "../plugins/plugins";
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

  let busy = false;
  let aborter: AbortController | undefined;
  let closing = false;

  // The readline interface is created before disk plugins load: the host
  // owns the terminal, and plugins attach /-completion providers through
  // the "repl" service once it is available.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
  const repl = new ReplCompletions({
    rl,
    input: process.stdin,
    output: process.stdout,
    enabled: () => !busy,
  });
  const disposeRepl = ctx.provide("repl", repl);

  // Resolve the optional UI plugin service per turn: disk plugins mount
  // after this function starts, so the service may appear at any time.
  const resolveUi = (): UiService | undefined => ctx.tryGet("ui") as UiService | undefined;

  // Disk plugins load after start() so they can inject every default
  // service; failures are isolated per plugin and shown in the banner.
  const loader = ctx.tryGet("pluginsLoader") as PluginsLoaderService | undefined;
  if (loader) await loader.init();

  // Interaction is a plugin, not a side-channel provide; mounting after
  // start() activates it immediately.
  handle.runtime.use(terminalInteractionPlugin, {
    onBeforeAsk: () => rl.pause(),
    onAfterAsk: () => rl.resume(),
  });

  printBanner(handle, session, permission.mode());

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
    disposeRepl();
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
          const rendered = error instanceof Error ? error.message : String(error);
          // A UI plugin may render errors with its own styling.
          const activeUi = resolveUi();
          activeUi?.renderError?.(error instanceof Error ? error : new Error(rendered));
          if (!activeUi) console.log(yellow(`error: ${rendered}`));
        }
        showPrompt();
        return;
      }

      busy = true;
      aborter = new AbortController();
      const uiService = resolveUi();
      if (uiService) {
        // The echoed input is the visual start of a turn; without a UI
        // plugin the readline prompt already showed what was typed.
        uiService.renderUserInput?.(line);
      }
      try {
        for await (const event of handle.run({ input: line, session: sessionRef.getSession(), signal: aborter.signal })) {
          if (uiService) uiService.render(event);
          else renderEvent(event);
        }
      } catch (error) {
        const rendered = error instanceof Error ? error.message : String(error);
        uiService?.renderError?.(error instanceof Error ? error : new Error(rendered));
        if (!uiService) console.log(yellow(`error: ${rendered}`));
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
  const loader = handle.runtime.ctx.tryGet("pluginsLoader") as PluginsLoaderService | undefined;
  const statuses = loader?.list() ?? [];
  const info: UiBannerInfo = {
    version,
    model: llm.defaultRef() ?? "unset",
    mode,
    sessionId: session.id,
    plugins: {
      loaded: statuses.filter((status) => status.status === "loaded").length,
      total: statuses.length,
      errors: statuses
        .filter((status): status is typeof status & { error: string } => status.status === "error")
        .map((status) => ({ name: status.name, error: status.error ?? "" })),
    },
  };
  const ui = handle.runtime.ctx.tryGet("ui") as UiService | undefined;
  if (ui?.renderBanner) {
    ui.renderBanner(info);
    return;
  }
  console.log(bold("flavor-lite") + dim(" — everything is a plugin"));
  console.log(dim(`model ${info.model} · mode ${mode} · session ${session.id}`));
  if (statuses.length > 0) {
    console.log(dim(`plugins ${info.plugins.loaded}/${statuses.length} loaded (/plugin list)`));
    for (const status of statuses) {
      if (status.status === "error") console.log(yellow(`  plugin "${status.name}" failed: ${status.error}`));
    }
  }
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
