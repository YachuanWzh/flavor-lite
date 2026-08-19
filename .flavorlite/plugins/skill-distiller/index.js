// skill-distiller — distill successful sessions into reusable SKILL.md SOPs.
//
// The skills plugin (src/plugins/skills) already discovers and injects
// `.flavorlite/skills/<slug>/SKILL.md`; what was missing was the generation
// side. This plugin closes that gap, mirroring the memory plugin's
// extract-after-run pattern:
//
//   loop/after-run (gates: reason=finished, toolCalls >= minToolCalls,
//                    generated cap not reached)
//   -> read the session transcript via the session service
//   -> ask the LLM for a strict-JSON SOP proposal (or {"skip": true})
//   -> write .flavorlite/skills/<slug>/SKILL.md with `generated: true`
//   -> next session: the skills plugin discovers and injects it.
//
// Everything is bounded and reversible: distillation is fire-and-forget and
// never blocks the loop, existing skill slugs are never overwritten, the
// total number of generated skills is capped, and `/distill rm <slug>` only
// removes skills this plugin generated (human skills are protected).

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MIN_TOOL_CALLS = 8;
const DEFAULT_MAX_GENERATED = 20;
const MAX_BODY_CHARS = 8000;

/** Turn a skill title into a valid directory name. */
function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Collect a full text response from an async-iterable LLM stream.
 * Returns undefined when the stream fails or yields no text.
 */
async function collectLlmText(llm, options) {
  try {
    let text = "";
    const stream = llm.stream(options);
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text;
    }
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parse the model's strict-JSON reply; tolerates code fences and prose. */
function parseDistillReply(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Enumerate skills on disk: [{ slug, generated, promoted }] (dirs with a SKILL.md). */
async function listSkills(skillsDir) {
  let entries;
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  const skills = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(skillsDir, slug, "SKILL.md"), "utf-8");
      skills.push({
        slug,
        generated: /generated:\s*true/.test(raw),
        promoted: /promoted:\s*true/.test(raw),
      });
    } catch {
      // entry without SKILL.md is not a skill
    }
  }
  return skills;
}

export default {
  name: "skill-distiller",
  version: "0.1.0",
  description: "distill successful multi-step sessions into reusable SKILL.md SOPs",
  provides: ["skillDistiller"],
  inject: ["hooks", "commands"],

  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const minToolCalls = Number.isFinite(config.minToolCalls) ? config.minToolCalls : DEFAULT_MIN_TOOL_CALLS;
      const maxGenerated = Number.isFinite(config.maxGenerated) ? config.maxGenerated : DEFAULT_MAX_GENERATED;
      const skillsDir = join(ctx.cwd, ".flavorlite", "skills");
      const disposers = [];
      // Pending distillations; the skillDistiller service can await them.
      const pending = new Set();

      function track(promise) {
        pending.add(promise);
        promise.finally(() => pending.delete(promise));
      }

      // Service: lets tests/diagnostics wait until distillation settles.
      disposers.push(
        ctx.provide("skillDistiller", {
          idle: async () => {
            while (pending.size > 0) await Promise.allSettled([...pending]);
          },
        }),
      );

      async function distill() {
        const llm = ctx.tryGet("llm");
        const session = ctx.tryGet("session");
        if (!llm || !session) return;

        let messages;
        try {
          const latestId = await session.latest();
          if (!latestId) return;
          const handle = await session.open(latestId);
          messages = handle.messages();
        } catch {
          return;
        }
        if (!messages || messages.length === 0) return;

        const existing = await listSkills(skillsDir);
        const generatedCount = existing.filter((skill) => skill.generated).length;
        if (generatedCount >= maxGenerated) {
          ctx.logger.debug("skill-distiller: generated skill cap reached, skipping");
          return;
        }

        const knownSlugs = existing.map((skill) => skill.slug);
        const systemPrompt = [
          "You are the skill distiller of a coding agent.",
          "Review the finished session below and decide whether it contains a reusable,",
          "multi-step workflow worth keeping as a skill (standard operating procedure).",
          `Existing skills (do not duplicate them): ${knownSlugs.length > 0 ? knownSlugs.join(", ") : "(none)"}`,
          "Reply with STRICT JSON only, no prose:",
          '- nothing reusable, or it duplicates an existing skill: {"skip": true, "reason": "<short reason>"}',
          '- otherwise: {"name": "<short imperative title>", "description": "<one line: when to use + what it does>", "body": "<markdown SOP with concrete steps, commands, checks>"}',
        ].join("\n");

        const raw = await collectLlmText(llm, { systemPrompt, messages, maxTokens: 1200 });
        if (raw === undefined) {
          ctx.logger.debug("skill-distiller: LLM produced no output");
          return;
        }
        const reply = parseDistillReply(raw);
        if (!reply || reply.skip === true) return;

        const name = typeof reply.name === "string" ? reply.name.trim() : "";
        const description = typeof reply.description === "string" ? reply.description.trim() : "";
        const body = typeof reply.body === "string" ? reply.body.trim() : "";
        const slug = slugify(name);
        if (!slug || !description || !body) {
          ctx.logger.debug("skill-distiller: reply missing name/description/body");
          return;
        }
        if (existing.some((skill) => skill.slug === slug)) {
          ctx.logger.debug(`skill-distiller: skill "${slug}" already exists, skipping`);
          return;
        }

        const targetDir = join(skillsDir, slug);
        await mkdir(targetDir, { recursive: true });
        await writeFile(
          join(targetDir, "SKILL.md"),
          [
            "---",
            `name: ${name}`,
            `description: ${description}`,
            "generated: true",
            `distilledAt: ${new Date().toISOString()}`,
            "---",
            "",
            body.slice(0, MAX_BODY_CHARS),
            "",
          ].join("\n"),
          "utf-8",
        );
        ctx.logger.info(`skill-distiller: distilled new skill "${slug}"`);
      }

      // Distill after successful, non-trivial runs. Fire-and-forget: the loop
      // must never block on extraction (same policy as the memory plugin).
      disposers.push(
        ctx.get("hooks").hook("loop/after-run", async (event, next) => {
          try {
            if (event.reason === "finished" && (event.toolCalls ?? 0) >= minToolCalls) {
              track(
                distill().catch((error) => {
                  ctx.logger.warn(
                    `skill-distiller: distillation failed — ${error instanceof Error ? error.message : String(error)}`,
                  );
                }),
              );
            }
          } catch (error) {
            ctx.logger.warn(
              `skill-distiller: after-run gate failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return next(event);
        }),
      );

      // Manage generated skills.
      disposers.push(
        ctx.get("commands").register({
          name: "distill",
          description: "Manage generated skills: /distill lists them, /distill promote <slug> curates one, /distill rm <slug> removes one",
          async run(args) {
            const arg = String(args ?? "").trim();

            if (arg.startsWith("promote ")) {
              const slug = slugify(arg.slice(8).trim());
              if (!slug) return "usage: /distill promote <skill-slug>";
              const existing = await listSkills(skillsDir);
              const entry = existing.find((skill) => skill.slug === slug);
              if (!entry) return `no skill named "${slug}"`;
              if (!entry.generated) return `refusing: "${slug}" is not a generated skill`;
              // Promotion is the human gate of the generated -> curated rung:
              // the skill leaves the generation quota and rm-protection scope.
              const skillFile = join(skillsDir, slug, "SKILL.md");
              const raw = await readFile(skillFile, "utf-8");
              const upgraded = raw.replace(
                /^generated:\s*true\s*$/m,
                `generated: false\npromoted: true\npromotedAt: ${new Date().toISOString()}`,
              );
              await writeFile(skillFile, upgraded, "utf-8");
              return `promoted "${slug}" to curated (no longer counted against the generated cap, protected from /distill rm)`;
            }

            if (arg.startsWith("rm ")) {
              const slug = slugify(arg.slice(3).trim());
              if (!slug) return "usage: /distill rm <skill-slug>";
              const existing = await listSkills(skillsDir);
              const entry = existing.find((skill) => skill.slug === slug);
              if (!entry) return `no skill named "${slug}"`;
              if (!entry.generated) return `refusing: "${slug}" is not generated by skill-distiller`;
              await rm(join(skillsDir, slug), { recursive: true, force: true });
              return `removed generated skill "${slug}"`;
            }

            const existing = await listSkills(skillsDir);
            if (existing.length === 0) return "no skills on disk yet";
            const generated = existing.filter((skill) => skill.generated);
            return [
              `generated skills: ${generated.length}/${maxGenerated}`,
              ...existing.map((skill) => `- ${skill.slug}${skill.generated ? " (generated)" : skill.promoted ? " (promoted)" : ""}`),
            ].join("\n");
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "skill-distiller.install");
  },
};
