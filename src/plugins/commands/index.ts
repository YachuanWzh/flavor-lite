/**
 * Commands capability seam: slash commands ("/model", "/init", ...) are
 * registrations, so feature plugins own their own commands instead of the
 * host hard-coding them.
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";

export interface Command {
  name: string;
  description: string;
  /** Return text to display, or undefined for silent success. */
  run(args: string): Promise<string | undefined> | string | undefined;
}

export interface CommandsService {
  register(command: Command): () => void;
  list(): Command[];
  get(name: string): Command | undefined;
  /** Dispatch "/name args". Returns the command's display text. */
  execute(line: string): Promise<string | undefined>;
}

class CommandsServiceImpl implements CommandsService {
  private commands = new Map<string, Command>();

  register(command: Command): () => void {
    if (this.commands.has(command.name)) {
      throw new Error(`command "/${command.name}" is already registered`);
    }
    this.commands.set(command.name, command);
    return () => {
      this.commands.delete(command.name);
    };
  }

  list(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  async execute(line: string): Promise<string | undefined> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return undefined;
    const space = trimmed.indexOf(" ");
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1);
    const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
    const command = this.commands.get(name);
    if (!command) return `Unknown command "/${name}". Use /help to list commands.`;
    return command.run(args);
  }
}

export const commandsPlugin = definePlugin({
  name: "commands",
  provides: ["commands"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => ctx.provide("commands", new CommandsServiceImpl()), "commands.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    commands: CommandsService;
  }
}
