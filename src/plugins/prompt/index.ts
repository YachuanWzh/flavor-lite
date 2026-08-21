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
  /** Higher-priority sections survive global prompt-budget trimming first. Default 50. */
  priority?: number;
  /** Per-section inline cap. */
  maxChars?: number;
  /** Diagnostic provenance shown by inspect(). */
  source?: string;
  cacheKey?: string;
  /** False keeps the contribution discoverable to hooks but excludes it from assembly. */
  enabled?: boolean;
}

/** Waterfall payload: mutate `sections`, then delegate via next(). */
export interface PromptAssemble {
  cwd: string;
  sections: PromptSection[];
}

export interface PromptService {
  /** Assemble the full system prompt right now. */
  assemble(): Promise<string>;
  inspect(): Promise<PromptInspection>;
}

export interface PromptInspectionSection {
  name: string;
  source?: string;
  priority: number;
  originalChars: number;
  includedChars: number;
  truncated: boolean;
  dropped: boolean;
}

export interface PromptInspection {
  maxChars?: number;
  totalChars: number;
  sections: PromptInspectionSection[];
}

export interface PromptPluginConfig {
  /** Global content budget. Headings/separators add a small amount beyond it. Unset = unlimited. */
  maxChars?: number;
}

class PromptServiceImpl implements PromptService {
  constructor(
    private readonly ctx: PluginContext,
    private readonly maxChars?: number,
  ) {}

  async assemble(): Promise<string> {
    const { sections } = await this.collect();
    return sections
      .filter((section) => section.included.length > 0)
      .map((section) => `# ${capitalize(section.value.name)}\n\n${section.included.trim()}`)
      .join("\n\n");
  }

  async inspect(): Promise<PromptInspection> {
    const { sections } = await this.collect();
    return {
      ...(this.maxChars !== undefined ? { maxChars: this.maxChars } : {}),
      totalChars: sections.reduce((sum, section) => sum + section.included.length, 0),
      sections: sections.map((section) => ({
        name: section.value.name,
        ...(section.value.source ? { source: section.value.source } : {}),
        priority: section.priority,
        originalChars: section.value.content.length,
        includedChars: section.included.length,
        truncated: section.included.length < section.value.content.length,
        dropped: section.included.length === 0,
      })),
    };
  }

  private async collect(): Promise<{ sections: Array<{ value: PromptSection; included: string; priority: number }> }> {
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
    const sections = [...byName.values()]
      .filter((section) => section.enabled !== false)
      .map((value) => ({
        value,
        priority: Number.isFinite(value.priority) ? value.priority! : 50,
        included: value.content.slice(0, Math.max(0, value.maxChars ?? value.content.length)),
      }));
    if (this.maxChars !== undefined) {
      let excess = sections.reduce((sum, section) => sum + section.included.length, 0) - this.maxChars;
      const trimOrder = sections
        .map((section, index) => ({ section, index }))
        .sort((left, right) => left.section.priority - right.section.priority || right.index - left.index);
      for (const { section } of trimOrder) {
        if (excess <= 0) break;
        const cut = Math.min(excess, section.included.length);
        section.included = section.included.slice(0, section.included.length - cut);
        excess -= cut;
      }
    }
    return { sections };
  }
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const promptPlugin = definePlugin<PromptPluginConfig>({
  name: "prompt",
  inject: ["hooks"],
  provides: ["systemPrompt"],
  apply(ctx: PluginContext, config: PromptPluginConfig = {}) {
    return ctx.effect(() => ctx.provide("systemPrompt", new PromptServiceImpl(ctx, config.maxChars)), "prompt.provide");
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
