/**
 * Init plugin: the project guide (FLAVOR.md) as a plugin.
 * - If `.flavor/FLAVOR.md` or `FLAVOR.md` exists at the project root, its
 *   content becomes a prompt section on every request.
 * - `/init` runs one agent turn that explores the project and writes
 *   `.flavor/FLAVOR.md`, so the guide itself is produced by the agent.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { AgentEvent } from "../loop";
import type { PromptAssemble } from "../prompt";
import type { CommandsService } from "../commands";

const GUIDE_CANDIDATES = [".flavor/FLAVOR.md", "FLAVOR.md"];

async function findGuide(cwd: string): Promise<string | undefined> {
  for (const candidate of GUIDE_CANDIDATES) {
    const path = join(cwd, candidate);
    try {
      await access(path);
      return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

const INIT_TASK = [
  "Explore this project (structure, package manifests, entry points, tests, build/test commands) and create the project guide file .flavor/FLAVOR.md.",
  "The guide is read by a coding agent on every session, so keep it under ~120 lines and factual:",
  "- one-paragraph project purpose",
  "- key directories and their roles",
  "- exact build / test / lint commands",
  "- conventions that are visible in the code (naming, imports, error handling)",
  "Do not invent commands you did not verify from files. Write the file with the Write tool, then reply with a one-line summary.",
].join("\n");

export const initPlugin = definePlugin({
  name: "init",
  inject: ["hooks", "commands"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => {
      const commands = ctx.get("commands") as CommandsService;

      const disposeSection = ctx.get("hooks").hook<PromptAssemble>("prompt/assemble", async (event, next) => {
        const guidePath = await findGuide(ctx.cwd);
        if (guidePath) {
          const raw = await readFile(guidePath, "utf-8");
          event.sections.push({
            name: "project-guide",
            content: `Project guide (${guidePath}):\n\n${raw.trim()}`,
          });
        }
        return next(event);
      });

      const disposeCommand = commands.register({
        name: "init",
        description: "Generate .flavor/FLAVOR.md by exploring the project",
        async run() {
          const agent = ctx.tryGet("agent") as import("../loop").AgentService | undefined;
          if (!agent) return "The loop plugin is not mounted; /init needs the agent service.";
          let lastText = "";
          for await (const event of agent.run({ input: INIT_TASK }) as AsyncIterable<AgentEvent>) {
            if (event.type === "text_delta") process.stdout.write(event.text);
            else if (event.type === "message_end") lastText = event.message.content;
          }
          const guide = await findGuide(ctx.cwd);
          return guide ? `\nProject guide written to ${guide}.` : `\nDone. Last reply: ${lastText.slice(0, 200)}`;
        },
      });

      return () => {
        disposeCommand();
        disposeSection();
      };
    }, "init.install");
  },
});
