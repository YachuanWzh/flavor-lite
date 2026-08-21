import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readGeneratedSkills(cwd) {
  const root = join(cwd, ".flavorlite", "skills");
  let names;
  try { names = await readdir(root); } catch { return []; }
  const result = [];
  for (const name of names) {
    const path = join(root, name, "SKILL.md");
    try {
      const raw = await readFile(path, "utf-8");
      if (/^generated:\s*true\s*$/mi.test(raw)) result.push({ name, path, raw, quarantined: /^quarantined:\s*true\s*$/mi.test(raw), distilledAt: /^distilledAt:\s*(.+)$/mi.exec(raw)?.[1]?.trim() });
    } catch { /* optional entry */ }
  }
  return result;
}

async function setSkillQuarantine(skill, quarantined, reason = "") {
  let raw = skill.raw;
  if (/^quarantined:/mi.test(raw)) raw = raw.replace(/^quarantined:.*$/mi, `quarantined: ${quarantined}`);
  else raw = raw.replace(/^---\s*$/m, `---\nquarantined: ${quarantined}`);
  if (/^quarantineReason:/mi.test(raw)) raw = raw.replace(/^quarantineReason:.*$/mi, `quarantineReason: ${reason.replace(/\s+/g, " ")}`);
  else raw = raw.replace(/^---\s*$/m, `---\nquarantineReason: ${reason.replace(/\s+/g, " ")}`);
  await writeFile(skill.path, raw, "utf-8");
}

async function setPluginLifecycle(status, state, reason) {
  const path = join(status.dir, "flavor-plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf-8"));
  manifest.lifecycle = { state, reason, updatedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

export default {
  name: "asset-governance",
  inject: ["hooks", "commands", "pluginsLoader", "telemetry"],
  provides: ["assetGovernance"],
  apply(ctx, config = {}) {
    const runsBetween = Number.isFinite(config.sweepEveryRuns) ? Math.max(1, config.sweepEveryRuns) : 10;
    const unusedMs = (Number.isFinite(config.unusedSkillDays) ? Math.max(1, config.unusedSkillDays) : 30) * 86400000;
    const maxSkills = Number.isFinite(config.maxGeneratedSkills) ? Math.max(1, config.maxGeneratedSkills) : 20;
    const minFeedback = Number.isFinite(config.minPluginFeedback) ? Math.max(1, config.minPluginFeedback) : 5;
    const minPrecision = Number.isFinite(config.minPluginPrecision) ? config.minPluginPrecision : 0.4;
    const telemetry = ctx.get("telemetry");
    const loader = ctx.get("pluginsLoader");
    let runs = 0;

    const sweep = async () => {
      const actions = [];
      const events = await telemetry.events();
      const usedAt = new Map();
      for (const event of events) if (event.type === "skill.used" && typeof event.skill === "string") usedAt.set(event.skill, Math.max(usedAt.get(event.skill) ?? 0, Date.parse(event.ts)));
      const skills = await readGeneratedSkills(ctx.cwd);
      const active = skills.filter((skill) => !skill.quarantined).sort((a, b) => (usedAt.get(a.name) ?? Date.parse(a.distilledAt ?? 0)) - (usedAt.get(b.name) ?? Date.parse(b.distilledAt ?? 0)));
      for (const [index, skill] of active.entries()) {
        const last = usedAt.get(skill.name) ?? Date.parse(skill.distilledAt ?? 0);
        if (index < Math.max(0, active.length - maxSkills) || (Number.isFinite(last) && Date.now() - last > unusedMs)) {
          await setSkillQuarantine(skill, true, index < active.length - maxSkills ? "generated skill cap exceeded" : "unused past retention window");
          actions.push(`skill:${skill.name}`);
        }
      }
      const feedback = new Map();
      for (const event of events) {
        if (event.type !== "router.feedback") continue;
        for (const item of event.entries ?? []) {
          if (!item?.plugin) continue;
          const count = feedback.get(item.plugin) ?? { used: 0, unused: 0 };
          item.used ? count.used++ : count.unused++;
          feedback.set(item.plugin, count);
        }
      }
      for (const status of loader.list()) {
        if (status.origin !== "generated" || status.lifecycle?.state === "quarantined") continue;
        const count = feedback.get(status.name);
        if (!count || count.used + count.unused < minFeedback) continue;
        const precision = count.used / (count.used + count.unused);
        if (precision < minPrecision) {
          await loader.eject(status.name).catch(() => {});
          await setPluginLifecycle(status, "quarantined", `router precision ${precision.toFixed(2)} below ${minPrecision}`);
          actions.push(`plugin:${status.name}`);
        }
      }
      return actions;
    };

    const disposeService = ctx.provide("assetGovernance", { sweep });
    const disposeHook = ctx.get("hooks").hook("loop/after-run", async (event, next) => {
      runs += 1;
      if (runs % runsBetween === 0) await sweep().catch((error) => ctx.logger.warn(`asset governance sweep failed: ${error.message}`));
      return next(event);
    });
    const disposeCommand = ctx.get("commands").register({
      name: "governance",
      description: "Inspect/sweep/restore generated assets",
      async run(args) {
        const [sub = "status", kind, name] = args.trim().split(/\s+/);
        if (sub === "status") {
          const skills = await readGeneratedSkills(ctx.cwd);
          const plugins = loader.list().filter((status) => status.origin === "generated");
          return `generated assets: ${skills.filter((skill) => !skill.quarantined).length} active skills, ${skills.filter((skill) => skill.quarantined).length} quarantined skills, ${plugins.length} plugins`;
        }
        if (sub === "sweep") return `quarantined: ${(await sweep()).join(", ") || "none"}`;
        if (sub === "restore" && kind === "skill" && name) {
          const skill = (await readGeneratedSkills(ctx.cwd)).find((entry) => entry.name === name);
          if (!skill) return `skill ${name} not found`;
          await setSkillQuarantine(skill, false, "restored by operator");
          return `restored skill ${name}`;
        }
        if (sub === "restore" && kind === "plugin" && name) {
          const status = loader.list().find((entry) => entry.name === name);
          if (!status) return `plugin ${name} not found`;
          await setPluginLifecycle(status, "active", "restored by operator");
          return `restored plugin ${name}; reload it explicitly when ready`;
        }
        return "usage: /governance status|sweep|restore skill|plugin <name>";
      },
    });
    return () => { disposeCommand(); disposeHook(); disposeService(); };
  },
};
