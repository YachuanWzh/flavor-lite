import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin, type PromptAssemble } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { LoopAfterRun } from "../src/plugins/loop";

/**
 * The knowledge-promoter plugin under test is loaded the way a user loads
 * it: through the plugins loader from the real
 * .flavorlite/plugins/knowledge-promoter/ directory, copied into an isolated
 * temp root. memory/skills/session are stubbed.
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/knowledge-promoter", import.meta.url));

async function copyDir(source: string, targetRoot: string): Promise<string> {
  const name = source.split(/[\\/]/).pop() as string;
  const target = join(targetRoot, name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    await writeFile(join(target, file), await readFile(join(source, file), "utf-8"));
  }
  return target;
}

interface MemoryRef {
  id: string;
  topicKey: string;
  summary: string;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
}

let memoryRefs: MemoryRef[] = [];
let discoveredSkills: DiscoveredSkill[] = [];
let transcriptMessages: Array<{ role: string; content: string }> = [];
let usedSkills: DiscoveredSkill[] = [];
let runCounter = 0;

function stubMemoryPlugin() {
  return definePlugin({
    name: "stub-memory",
    provides: ["memory"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("memory", {
            store: { references: async () => memoryRefs },
          }),
        "stub-memory.install",
      );
    },
  });
}

function stubSkillsPlugin() {
  return definePlugin({
    name: "stub-skills",
    provides: ["skills"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("skills", {
            discover: async () => discoveredSkills,
            usedInRun: async () => usedSkills,
          }),
        "stub-skills.install",
      );
    },
  });
}

function stubSessionPlugin() {
  return definePlugin({
    name: "stub-session",
    provides: ["session"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("session", {
            latest: async () => (transcriptMessages.length > 0 ? "s1" : undefined),
            open: async () => ({ messages: () => transcriptMessages }),
          }),
        "stub-session.install",
      );
    },
  });
}

function topicRefs(topic: string, count: number): MemoryRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${topic}-${index}`,
    topicKey: topic,
    summary: `Lesson ${index + 1} about ${topic}.`,
  }));
}

const finishedRun: LoopAfterRun = {
  iterations: 4,
  reason: "finished",
  toolCalls: 9,
  toolErrors: 0,
  steers: 0,
  inputTokens: 100,
  outputTokens: 50,
};

describe("knowledge-promoter plugin", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-promoter-"));
    memoryRefs = [];
    discoveredSkills = [];
    transcriptMessages = [];
    usedSkills = [];
    runCounter = 0;
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(stubMemoryPlugin())
      .use(stubSkillsPlugin())
      .use(stubSessionPlugin())
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
    const status = loader.list().find((entry) => entry.name === "knowledge-promoter");
    if (status?.status !== "loaded") {
      throw new Error(`knowledge-promoter failed to load: ${status?.error ?? "no status"}`);
    }
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function commands(): CommandsService {
    return runtime.ctx.get("commands") as CommandsService;
  }

  function hooks(): HookBusService {
    return runtime.ctx.get("hooks") as HookBusService;
  }

  async function endRun(stats: LoopAfterRun = finishedRun): Promise<void> {
    runCounter += 1;
    await hooks().waterfall<LoopAfterRun>("loop/after-run", {
      ...stats,
      runId: `run-${runCounter}`,
      successful: stats.successful ?? (stats.reason === "finished" && stats.toolErrors === 0),
    });
  }

  async function assembleSections(): Promise<PromptAssemble["sections"]> {
    const payload = await hooks().waterfall<PromptAssemble>("prompt/assemble", { cwd: dir, sections: [] });
    return payload.sections;
  }

  it("reports no open proposals when nothing has accumulated", async () => {
    expect(await commands().execute("/ladder")).toContain("no open proposals");
    const sections = await assembleSections();
    expect(sections.find((section) => section.name === "knowledge-promoter")).toBeUndefined();
  });

  it("proposes a skill once a memory topic reaches the threshold, and to-skill drafts it", async () => {
    memoryRefs = topicRefs("tooling.errors", 3);

    const listing = (await commands().execute("/ladder")) ?? "";
    expect(listing).toContain("tooling.errors");
    expect(listing).toContain("/ladder to-skill tooling.errors");

    const section = (await assembleSections()).find((entry) => entry.name === "knowledge-promoter");
    expect(section?.content).toContain("tooling.errors");

    const converted = (await commands().execute("/ladder to-skill tooling.errors")) ?? "";
    expect(converted.toLowerCase()).toContain("drafted");

    const skillFile = join(dir, ".flavorlite", "skills", "tooling-errors", "SKILL.md");
    const content = await readFile(skillFile, "utf-8");
    expect(content).toContain("generated: true");
    expect(content).toContain("promotedFrom: memory");
    expect(content).toContain("Lesson 1 about tooling.errors.");
    expect(content).toContain("Lesson 3 about tooling.errors.");

    // Proposal closed and the draft is discoverable via /distill semantics.
    expect(await commands().execute("/ladder")).not.toContain("to-skill tooling.errors");
  });

  it("does not propose a topic below the threshold or already covered by a skill", async () => {
    memoryRefs = topicRefs("tooling.errors", 2);
    expect(await commands().execute("/ladder")).toContain("no open proposals");

    memoryRefs = topicRefs("tooling.errors", 3);
    await mkdir(join(dir, ".flavorlite", "skills", "tooling-errors"), { recursive: true });
    await writeFile(
      join(dir, ".flavorlite", "skills", "tooling-errors", "SKILL.md"),
      "---\nname: Tooling Errors\ndescription: existing\n---\nbody",
      "utf-8",
    );
    expect(await commands().execute("/ladder")).toContain("no open proposals");
  });

  it("counts skill usage once per successful run from actual SKILL.md reads", async () => {
    const skillDir = join(dir, ".flavorlite", "skills", "deploy-to-staging");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: Deploy to staging\ndescription: deploy workflow\n---\nNEEDLE_BODY run the deploy script",
      "utf-8",
    );
    discoveredSkills = [
      { name: "Deploy to staging", description: "deploy workflow", path: join(skillDir, "SKILL.md") },
    ];
    usedSkills = discoveredSkills;

    await endRun();
    const usage = JSON.parse(
      await readFile(join(dir, ".flavorlite", "knowledge-promoter", "skill-usage.json"), "utf-8"),
    );
    expect(usage["deploy-to-staging"].count).toBe(1);
    expect(await commands().execute("/ladder")).toContain("no open proposals");

    await endRun();
    await endRun();
    const listing = (await commands().execute("/ladder")) ?? "";
    expect(listing).toContain("deploy-to-staging");
    expect(listing).toContain("/ladder to-plugin deploy-to-staging");
  });

  it("ignores usage signals from unfinished runs", async () => {
    const skillDir = join(dir, ".flavorlite", "skills", "deploy-to-staging");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: Deploy to staging\ndescription: d\n---\nbody");
    discoveredSkills = [
      { name: "Deploy to staging", description: "d", path: join(skillDir, "SKILL.md") },
    ];
    usedSkills = discoveredSkills;

    await endRun({ ...finishedRun, reason: "max_iterations" });
    await endRun({ ...finishedRun, reason: "max_iterations" });
    await endRun({ ...finishedRun, reason: "max_iterations" });
    expect(await commands().execute("/ladder")).toContain("no open proposals");
  });

  it("to-plugin scaffolds a plugin with a PLAN.md carrying the skill body", async () => {
    const skillDir = join(dir, ".flavorlite", "skills", "deploy-to-staging");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: Deploy to staging\ndescription: deploy workflow\n---\nNEEDLE_BODY run the deploy script",
      "utf-8",
    );
    discoveredSkills = [
      { name: "Deploy to staging", description: "deploy workflow", path: join(skillDir, "SKILL.md") },
    ];
    usedSkills = discoveredSkills;
    await endRun();
    await endRun();
    await endRun();

    const converted = (await commands().execute("/ladder to-plugin deploy-to-staging")) ?? "";
    expect(converted).toContain("deploy-to-staging");

    const pluginDir = join(dir, ".flavorlite", "plugins", "deploy-to-staging");
    const plan = await readFile(join(pluginDir, "PLAN.md"), "utf-8");
    expect(plan).toContain("NEEDLE_BODY run the deploy script");

    // Proposal closed after conversion.
    expect(await commands().execute("/ladder")).not.toContain("to-plugin deploy-to-staging");

    const accepted = (await commands().execute("/ladder accept deploy-to-staging")) ?? "";
    expect(accepted).toContain("accepted plugin promotion");
  });

  it("warns when a promoted memory topic mixes conflicting platform guidance", async () => {
    memoryRefs = [
      { id: "1", topicKey: "tooling.shell", summary: "Use cmd.exe syntax on Windows." },
      { id: "2", topicKey: "tooling.shell", summary: "Use Bash pipelines on Linux." },
      { id: "3", topicKey: "tooling.shell", summary: "Verify the shell before choosing commands." },
    ];
    await commands().execute("/ladder to-skill tooling.shell");
    const content = await readFile(join(dir, ".flavorlite", "skills", "tooling-shell", "SKILL.md"), "utf-8");
    expect(content).toContain("mixed platform guidance");
    expect(content).toContain("Resolve contradictions");
  });

  it("does not count transcript mentions without an actual skill read", async () => {
    const skillDir = join(dir, ".flavorlite", "skills", "deploy-to-staging");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: Deploy\ndescription: deploy\n---\nbody");
    discoveredSkills = [{ name: "Deploy", description: "deploy", path: join(skillDir, "SKILL.md") }];
    transcriptMessages = [{ role: "user", content: "deploy-to-staging" }];
    usedSkills = [];

    await endRun();
    expect(await commands().execute("/ladder")).toContain("no open proposals");
  });

  it("refuses to-skill and to-plugin for unknown subjects", async () => {
    const unknownSkill = (await commands().execute("/ladder to-skill ghost.topic")) ?? "";
    expect(unknownSkill.toLowerCase()).toContain("no memories under topic");

    const unknownPlugin = (await commands().execute("/ladder to-plugin ghost")) ?? "";
    expect(unknownPlugin).toContain("no skill named");
  });
});
