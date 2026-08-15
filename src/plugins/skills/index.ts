/**
 * Skills plugin: flavor-style SKILL.md discovery. Skills live in
 * `.flavor/skills/<name>/SKILL.md` (project), `.flavorlite/skills/<name>/`
 * (flavor-lite native) and `~/.flavor/skills/` (user-global). Only name +
 * description are injected into the system prompt; the model reads the full
 * SKILL.md via Read when a skill applies — keeps the prompt lean and startup
 * fast.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { PromptAssemble } from "../prompt";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface SkillsService {
  /** Discover skills from project and user directories. */
  discover(): Promise<SkillInfo[]>;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION_LINE = /^description:\s*(.+)$/m;
const NAME_LINE = /^name:\s*(.+)$/m;

function parseSkillMeta(raw: string, fallbackName: string): { name: string; description: string } {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { name: fallbackName, description: raw.slice(0, 200).replace(/\s+/g, " ").trim() };
  const frontMatter = match[1] ?? "";
  const name = NAME_LINE.exec(frontMatter)?.[1]?.trim() || fallbackName;
  const description = DESCRIPTION_LINE.exec(frontMatter)?.[1]?.trim() || "(no description)";
  return { name, description };
}

class SkillsServiceImpl implements SkillsService {
  constructor(private readonly ctx: PluginContext) {}

  async discover(): Promise<SkillInfo[]> {
    const roots = [
      join(this.ctx.cwd, ".flavor", "skills"),
      join(this.ctx.cwd, ".flavorlite", "skills"),
      join(homedir(), ".flavor", "skills"),
    ];
    const skills = new Map<string, SkillInfo>();
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue; // skills dir is optional
      }
      for (const entry of entries) {
        if (skills.has(entry)) continue; // project skills shadow user skills
        const path = join(root, entry, "SKILL.md");
        try {
          const raw = await readFile(path, "utf-8");
          const meta = parseSkillMeta(raw, entry);
          skills.set(entry, { name: meta.name, description: meta.description, path });
        } catch {
          continue; // entry without SKILL.md is not a skill
        }
      }
    }
    return [...skills.values()];
  }
}

export const skillsPlugin = definePlugin({
  name: "skills",
  inject: ["hooks", "systemPrompt"],
  provides: ["skills"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => {
      const service = new SkillsServiceImpl(ctx);
      const disposeService = ctx.provide("skills", service);
      const disposeHook = ctx.get("hooks").hook<PromptAssemble>("prompt/assemble", async (event, next) => {
        const skills = await service.discover();
        if (skills.length > 0) {
          const lines = skills.map((skill) => `- **${skill.name}**: ${skill.description} (skill file: ${skill.path})`);
          event.sections.push({
            name: "skills",
            content:
              "These skills are available. When one clearly applies to the current task, read its SKILL.md with the Read tool and follow it.\n" +
              lines.join("\n"),
          });
        }
        return next(event);
      });
      return () => {
        disposeHook();
        disposeService();
      };
    }, "skills.install");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    skills: SkillsService;
  }
}
