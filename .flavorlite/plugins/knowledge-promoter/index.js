// knowledge-promoter — the memory -> skill -> plugin promotion ladder.
//
// Three knowledge forms already exist but never flowed between each other:
//   memory  (declarative facts, .flavorlite/memory)
//   skills  (procedural SOPs,  .flavorlite/skills/<slug>/SKILL.md)
//   plugins (executable code,  .flavorlite/plugins/<name>/)
//
// This plugin proposes the two upward promotions and hands the human-gated
// conversion commands to the operator/model:
//
//   memory -> skill   memory references are grouped by topicKey; once a
//                     topic accumulates >= memoryTopicThreshold entries it is
//                     proposed. /ladder to-skill <topic> drafts a SKILL.md
//                     from the topic's summaries (generated: true +
//                     promotedFrom: memory, so it joins the skill-distiller
//                     management surface: quota, promote, rm).
//   skill -> plugin   after every finished run the latest transcript is
//                     scanned for mentions of discovered skills; a mention
//                     counts once per skill per run (cross-run recurrence is
//                     the signal). Usage >= skillUsageThreshold proposes
//                     automation. /ladder to-plugin <slug> scaffolds the
//                     plugin dir and writes a PLAN.md carrying the skill body.
//
// Everything is bounded and reversible: proposals are proposals (surfaced via
// prompt/assemble and /ladder), conversions are explicit commands, acted-on
// subjects are marked done in .flavorlite/knowledge-promoter/done.json so
// they are never proposed again, and no LLM call is ever required.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_MEMORY_TOPIC_THRESHOLD = 3;
const DEFAULT_SKILL_USAGE_THRESHOLD = 3;
const DEFAULT_MAX_PROPOSALS = 8;

const SECTION = `# knowledge promotion ladder (knowledge-promoter plugin)

Reusable knowledge is accumulating. When one of these promotions is in scope
for the current task, run the matching /ladder command; otherwise ignore it.

{{PROPOSALS}}
`;

/** Turn a title or topic key into a valid directory/slug name. */
function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Human-readable title from a topic key ("tooling.errors" -> "Tooling Errors"). */
function titleCase(topicKey) {
  return String(topicKey)
    .split(/[._\-/\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The skills plugin stores each skill at <skillsDir>/<slug>/SKILL.md. */
function skillSlugFromPath(path) {
  return basename(dirname(String(path)));
}

/** Strip YAML front matter from a SKILL.md body. */
function stripFrontMatter(raw) {
  return String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function proposalLine(proposal) {
  return proposal.rung === "memory->skill"
    ? `- (memory -> skill) topic "${proposal.topic}" has ${proposal.count} memories — draft it: /ladder to-skill ${proposal.topic}`
    : `- (skill -> plugin) skill "${proposal.slug}" used in ${proposal.count} finished runs — automate it: /ladder to-plugin ${proposal.slug}`;
}

export default {
  name: "knowledge-promoter",
  version: "0.1.0",
  description: "promotion ladder: proposes memory->skill and skill->plugin promotions (/ladder)",
  provides: ["knowledgePromoter"],
  inject: ["hooks", "commands", "pluginsLoader"],

  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const memoryTopicThreshold = Number.isFinite(config.memoryTopicThreshold)
        ? config.memoryTopicThreshold
        : DEFAULT_MEMORY_TOPIC_THRESHOLD;
      const skillUsageThreshold = Number.isFinite(config.skillUsageThreshold)
        ? config.skillUsageThreshold
        : DEFAULT_SKILL_USAGE_THRESHOLD;
      const maxProposals = Number.isFinite(config.maxProposals) ? config.maxProposals : DEFAULT_MAX_PROPOSALS;

      const storeDir = join(ctx.cwd, ".flavorlite", "knowledge-promoter");
      const usageFile = join(storeDir, "skill-usage.json");
      const doneFile = join(storeDir, "done.json");
      const skillsDir = join(ctx.cwd, ".flavorlite", "skills");
      const disposers = [];

      async function readDone() {
        const list = await readJson(doneFile, []);
        return new Set(Array.isArray(list) ? list : []);
      }

      async function markDone(id) {
        const list = await readJson(doneFile, []);
        const done = Array.isArray(list) ? list : [];
        if (!done.includes(id)) {
          done.push(id);
          await writeJson(doneFile, done);
        }
      }

      /** Group memory references by topicKey: topic -> summaries. */
      async function memoryTopicGroups() {
        const memory = ctx.tryGet("memory");
        if (!memory?.store?.references) return new Map();
        let references = [];
        try {
          references = await memory.store.references();
        } catch {
          return new Map();
        }
        const groups = new Map();
        for (const ref of references ?? []) {
          const topic = typeof ref?.topicKey === "string" ? ref.topicKey.trim() : "";
          if (!topic) continue;
          if (!groups.has(topic)) groups.set(topic, []);
          groups.get(topic).push(typeof ref.summary === "string" ? ref.summary : "");
        }
        return groups;
      }

      /** memory -> skill candidates: repeated topics without a covering skill. */
      async function skillProposals(done) {
        const proposals = [];
        for (const [topic, summaries] of await memoryTopicGroups()) {
          if (summaries.length < memoryTopicThreshold) continue;
          if (done.has(`skill:${topic}`)) continue;
          const slug = slugify(topic);
          if (!slug) continue;
          try {
            await readFile(join(skillsDir, slug, "SKILL.md"), "utf-8");
            continue; // an existing skill already covers this topic
          } catch {
            // no covering skill: keep the proposal
          }
          proposals.push({ rung: "memory->skill", topic, slug, count: summaries.length, summaries });
        }
        return proposals.sort((a, b) => b.count - a.count);
      }

      /** skill -> plugin candidates: heavily used skills without a plugin yet. */
      async function pluginProposals(done, pluginNames) {
        const usage = await readJson(usageFile, {});
        const proposals = [];
        for (const [slug, count] of Object.entries(usage)) {
          if (!Number.isFinite(count) || count < skillUsageThreshold) continue;
          if (done.has(`plugin:${slug}`)) continue;
          if (pluginNames.has(slug)) continue;
          proposals.push({ rung: "skill->plugin", slug, count });
        }
        return proposals.sort((a, b) => b.count - a.count);
      }

      async function collectProposals() {
        const done = await readDone();
        const pluginNames = new Set(ctx.get("pluginsLoader").list().map((entry) => entry.name));
        const memorySide = await skillProposals(done);
        const pluginSide = await pluginProposals(done, pluginNames);
        return [...memorySide, ...pluginSide].slice(0, maxProposals);
      }

      // Service: exposes the proposal computation for tests/diagnostics.
      disposers.push(ctx.provide("knowledgePromoter", { proposals: collectProposals }));

      // USAGE: after every finished run, count transcript mentions of each
      // discovered skill — at most once per skill per run, so only cross-run
      // recurrence accumulates (same policy as evolve trigrams).
      disposers.push(
        ctx.get("hooks").hook("loop/after-run", async (event, next) => {
          try {
            if (event.reason === "finished") {
              const skills = ctx.tryGet("skills");
              const session = ctx.tryGet("session");
              if (skills?.discover && session) {
                let discovered = [];
                try {
                  discovered = await skills.discover();
                } catch {
                  discovered = [];
                }
                let messages = [];
                try {
                  const latestId = await session.latest();
                  if (latestId) messages = (await session.open(latestId)).messages() ?? [];
                } catch {
                  messages = [];
                }
                const haystack = messages
                  .filter((message) => message?.role === "user" || message?.role === "assistant")
                  .map((message) => (typeof message.content === "string" ? message.content : ""))
                  .join("\n")
                  .toLowerCase();
                if (haystack && discovered.length > 0) {
                  const usage = await readJson(usageFile, {});
                  let changed = false;
                  for (const skill of discovered) {
                    const slug = typeof skill?.path === "string"
                      ? skillSlugFromPath(skill.path)
                      : slugify(skill?.name ?? "");
                    if (!slug) continue;
                    const needles = [slug, slug.replace(/-/g, " "), String(skill?.name ?? "").toLowerCase()];
                    if (needles.some((needle) => needle && haystack.includes(needle))) {
                      usage[slug] = (usage[slug] ?? 0) + 1;
                      changed = true;
                    }
                  }
                  if (changed) await writeJson(usageFile, usage);
                }
              }
            }
          } catch (error) {
            ctx.logger.warn(
              `knowledge-promoter: usage tracking failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return next(event);
        }),
      );

      // ASSESS: surface open proposals in the system prompt.
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          try {
            const proposals = await collectProposals();
            if (proposals.length > 0) {
              event.sections.push({
                name: "knowledge-promoter",
                content: SECTION.replace("{{PROPOSALS}}", proposals.map(proposalLine).join("\n")),
              });
            }
          } catch (error) {
            ctx.logger.warn(
              `knowledge-promoter: prompt section failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return next(event);
        }),
      );

      // CONVERT: the two human-gated promotion commands.
      disposers.push(
        ctx.get("commands").register({
          name: "ladder",
          description: "Knowledge promotion ladder: /ladder lists proposals, /ladder to-skill <topic> and /ladder to-plugin <slug> convert them",
          async run(args) {
            const arg = String(args ?? "").trim();

            if (arg.startsWith("to-skill ")) {
              const topic = arg.slice(9).trim();
              if (!topic) return "usage: /ladder to-skill <topicKey>";
              const summaries = (await memoryTopicGroups()).get(topic);
              if (!summaries || summaries.length === 0) return `no memories under topic "${topic}"`;
              const slug = slugify(topic);
              const skillFile = join(skillsDir, slug, "SKILL.md");
              try {
                await readFile(skillFile, "utf-8");
                return `refusing: skill "${slug}" already exists`;
              } catch {
                // free slug: draft the skill
              }
              const title = titleCase(topic);
              await mkdir(join(skillsDir, slug), { recursive: true });
              await writeFile(
                skillFile,
                [
                  "---",
                  `name: ${title}`,
                  `description: Distilled from ${summaries.length} long-term memories under topic "${topic}".`,
                  "generated: true",
                  "promotedFrom: memory",
                  `promotedAt: ${new Date().toISOString()}`,
                  "---",
                  "",
                  `# ${title}`,
                  "",
                  `Lessons accumulated in long-term memory (topic: ${topic}):`,
                  "",
                  ...summaries.map((summary) => `- ${summary}`),
                  "",
                  "Refine this draft into a reusable step-by-step procedure. When it proves",
                  `useful, run /distill promote ${slug} to curate it.`,
                  "",
                ].join("\n"),
                "utf-8",
              );
              await markDone(`skill:${topic}`);
              return `drafted skill "${slug}" at ${skillFile} (from ${summaries.length} memories) — refine it, then /distill promote ${slug} to curate`;
            }

            if (arg.startsWith("to-plugin ")) {
              const slug = slugify(arg.slice(10).trim());
              if (!slug) return "usage: /ladder to-plugin <skill-slug>";
              const skillFile = join(skillsDir, slug, "SKILL.md");
              let raw;
              try {
                raw = await readFile(skillFile, "utf-8");
              } catch {
                return `no skill named "${slug}"`;
              }
              const loader = ctx.get("pluginsLoader");
              let dir;
              try {
                dir = await loader.scaffold(slug);
              } catch (error) {
                return `failed to scaffold plugin "${slug}": ${error instanceof Error ? error.message : String(error)}`;
              }
              // Provenance: the promotion ladder is agent-driven, so mark the
              // scaffold as generated (manifest schema supports origin).
              try {
                const manifestFile = join(dir, "flavor-plugin.json");
                const manifest = await readJson(manifestFile, null);
                if (manifest && typeof manifest === "object") {
                  manifest.origin = "generated";
                  manifest.generatedFrom = new Date().toISOString();
                  await writeJson(manifestFile, manifest);
                }
              } catch {
                // manifest missing: leave provenance to the caller
              }
              const usage = await readJson(usageFile, {});
              const count = Number.isFinite(usage[slug]) ? usage[slug] : 0;
              try {
                await writeFile(
                  join(dir, "PLAN.md"),
                  [
                    "# skill -> plugin promotion plan",
                    "",
                    `Source skill: .flavorlite/skills/${slug}/SKILL.md (used in ${count} finished runs)`,
                    "",
                    "## Skill content",
                    "",
                    stripFrontMatter(raw),
                    "",
                    "## Implementation",
                    "",
                    "1. implement index.js per the create-flavor-plugin skill contract — automate the procedure above as a tool or command",
                    "2. declare capabilities in flavor-plugin.json if any tool needs them: \"files\" for tools that write files, \"shell\" for tools that run commands — undeclared capabilities are blocked by the permission engine for generated plugins",
                    `3. /evolve verify ${slug} (sandbox dry-run must pass before activation)`,
                    `4. /plugin reload ${slug}`,
                    "5. /evolve test",
                    `6. on failure: /evolve revert ${slug} restores the last good version`,
                    "",
                  ].join("\n"),
                  "utf-8",
                );
              } catch {
                // PLAN.md is best-effort; the scaffold itself already exists.
              }
              await markDone(`plugin:${slug}`);
              return [
                `scaffolded plugin at ${dir} from skill "${slug}".`,
                ``,
                `Now implement it yourself:`,
                `1. Write the plugin entry (index.js) per PLAN.md — the skill body describes the procedure to automate.`,
                `2. If any tool writes files or runs commands, add "capabilities": ["files"] or ["shell"] to flavor-plugin.json (generated plugins are read-only until they declare capabilities).`,
                `3. Run /evolve verify ${slug} — the sandbox dry-run must pass before activation.`,
                `4. Run /plugin reload ${slug} to hot-load it.`,
                `5. Run /evolve test to verify the suite still passes.`,
              ].join("\n");
            }

            const proposals = await collectProposals();
            if (proposals.length === 0) {
              return `no open proposals (memory topics need >= ${memoryTopicThreshold} entries, skills need >= ${skillUsageThreshold} used runs)`;
            }
            return ["open promotion proposals:", ...proposals.map(proposalLine)].join("\n");
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "knowledge-promoter.install");
  },
};
