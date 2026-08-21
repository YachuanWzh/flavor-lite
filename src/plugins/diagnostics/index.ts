import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { ArtifactService } from "../artifacts";
import type { CommandsService } from "../commands";
import type { PluginsLoaderService } from "../plugins";
import type { PromptService } from "../prompt";
import type { ToolRegistry } from "../tools";

export const diagnosticsPlugin = definePlugin({
  name: "diagnostics",
  inject: ["commands", "systemPrompt", "tools", "artifacts", "pluginsLoader"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => {
      const commands = ctx.get("commands") as CommandsService;
      const prompt = ctx.get("systemPrompt") as PromptService;
      const artifacts = ctx.get("artifacts") as ArtifactService;
      const loader = ctx.get("pluginsLoader") as PluginsLoaderService;
      const tools = ctx.get("tools") as ToolRegistry;
      const disposers = [
        commands.register({
          name: "prompt",
          description: "Inspect prompt sections and budget (/prompt inspect)",
          async run(args) {
            if (args.trim() && args.trim() !== "inspect") return "usage: /prompt inspect";
            const info = await prompt.inspect();
            return [
              `prompt: ${info.totalChars}/${info.maxChars ?? "∞"} content chars`,
              ...info.sections.map((section) =>
                `  ${section.dropped ? "DROP" : section.truncated ? "TRIM" : "KEEP"} ${section.name} ${section.includedChars}/${section.originalChars} p=${section.priority}${section.source ? ` source=${section.source}` : ""}`,
              ),
            ].join("\n");
          },
        }),
        commands.register({
          name: "artifacts",
          description: "List or prune bounded tool artifacts",
          async run(args) {
            if (args.trim() === "prune") return `pruned ${await artifacts.prune()} artifact(s)`;
            const entries = await artifacts.list(Number.parseInt(args.trim() || "20", 10));
            return entries.length ? entries.map((entry) => `${entry.id} ${entry.size ?? "?"} ${entry.path}`).join("\n") : "no artifacts";
          },
        }),
        commands.register({
          name: "why",
          description: "Explain a plugin or tool owner (/why <name>)",
          run(args) {
            const name = args.trim();
            if (!name) return "usage: /why <plugin-or-tool-name>";
            const status = loader.list().find((entry) => entry.name === name);
            if (status) return loader.explain(name);
            const tool = tools.get(name);
            if (tool) {
              const owner = loader.ownerOfTool(name);
              return [
                `tool ${name}: ${tool.description}`,
                `category: ${tool.category}`,
                `owner: ${owner?.name ?? "built-in or SDK plugin"}`,
                ...(owner ? [`origin: ${owner.origin}`, `capabilities: ${owner.capabilities?.join(", ") || "-"}`] : []),
              ].join("\n");
            }
            return `no plugin or tool named "${name}"`;
          },
        }),
      ];
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "diagnostics.install");
  },
});
