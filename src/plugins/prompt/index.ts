/**
 * Prompt plugin: a pure assembler. It runs the `prompt/assemble` waterfall
 * over an empty section list, deduplicates by name, and joins the result —
 * every word of the system prompt is contributed by other plugins
 * (guidance, permission, tools, skills, project guides). Mount no
 * contributors, get an empty system prompt.
 */

import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { HookBusService } from "../hooks";

export interface PromptSection {
  /** Stable name; later sections with the same name replace earlier ones. */
  name: string;
  content: string;
}

/** Waterfall payload: mutate `sections`, then delegate via next(). */
export interface PromptAssemble {
  cwd: string;
  sections: PromptSection[];
}

export interface PromptService {
  /** Assemble the full system prompt right now. */
  assemble(): Promise<string>;
}

class PromptServiceImpl implements PromptService {
  constructor(private readonly ctx: PluginContext) {}

  async assemble(): Promise<string> {
    const hooks = this.ctx.get("hooks") as HookBusService;
    // No built-in sections: contributors push theirs via the waterfall.
    const payload: PromptAssemble = {
      cwd: this.ctx.cwd,
      sections: [],
    };
    const assembled = await hooks.waterfall<PromptAssemble>("prompt/assemble", payload);

    // Deduplicate by name keeping the last occurrence, then join into markdown sections.
    const byName = new Map<string, PromptSection>();
    for (const section of assembled.sections) {
      if (!section.content.trim()) continue;
      byName.set(section.name, section);
    }
    return [...byName.values()]
      .map((section) => `# ${capitalize(section.name)}\n\n${section.content.trim()}`)
      .join("\n\n");
  }
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const promptPlugin = definePlugin({
  name: "prompt",
  inject: ["hooks"],
  provides: ["systemPrompt"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => ctx.provide("systemPrompt", new PromptServiceImpl(ctx)), "prompt.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    systemPrompt: PromptService;
  }
  interface HookMap {
    "prompt/assemble": PromptAssemble;
  }
}
