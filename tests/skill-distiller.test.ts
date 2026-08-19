import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import type { LoopAfterRun } from "../src/plugins/loop";

/**
 * The skill-distiller plugin under test is loaded the way a user loads it:
 * through the plugins loader from the real .flavorlite/plugins/skill-distiller/
 * directory, copied into an isolated temp root. llm/session are stubbed.
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/skill-distiller", import.meta.url));

async function copyDir(source: string, targetRoot: string): Promise<string> {
  const name = source.split(/[\\/]/).pop() as string;
  const target = join(targetRoot, name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    await writeFile(join(target, file), await readFile(join(source, file), "utf-8"));
  }
  return target;
}

interface LlmCall {
  systemPrompt?: string;
  messages?: Array<{ role: string; content?: unknown }>;
}

function stubLlmPlugin(reply: string, calls: LlmCall[]) {
  return definePlugin({
    name: "stub-llm",
    provides: ["llm"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("llm", {
            stream: async function* (options: LlmCall) {
              calls.push(options);
              yield { type: "text_delta", text: reply };
              yield { type: "done", stopReason: "end" };
            },
          }),
        "stub-llm.install",
      );
    },
  });
}

const TRANSCRIPT = [
  { role: "user", content: "deploy the app to staging (needle)" },
  { role: "assistant", content: "ran the deploy script, all green" },
];

function stubSessionPlugin() {
  return definePlugin({
    name: "stub-session",
    provides: ["session"],
    apply(ctx) {
      return ctx.effect(
        () =>
          ctx.provide("session", {
            latest: async () => "s1",
            open: async () => ({ messages: () => TRANSCRIPT }),
          }),
        "stub-session.install",
      );
    },
  });
}

const VALID_REPLY = JSON.stringify({
  name: "Deploy to staging",
  description: "When asked to deploy the app to staging, run the deploy script and verify health.",
  body: "# Deploy to staging\n\n1. run deploy script\n2. check health endpoint",
});

function finishedRun(toolCalls = 10): LoopAfterRun {
  return {
    iterations: 6,
    reason: "finished",
    toolCalls,
    toolErrors: 0,
    steers: 0,
    inputTokens: 100,
    outputTokens: 50,
  };
}

describe("skill-distiller plugin", () => {
  let dir: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;
  let llmCalls: LlmCall[];

  async function setup(reply: string, manifestConfig?: Record<string, unknown>): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "flavor-distiller-"));
    const pluginsRoot = join(dir, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await copyDir(PLUGIN_SOURCE, pluginsRoot);
    if (manifestConfig) {
      const manifestPath = join(pluginsRoot, "skill-distiller", "flavor-plugin.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      manifest.config = manifestConfig;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    }

    llmCalls = [];
    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(stubLlmPlugin(reply, llmCalls))
      .use(stubSessionPlugin())
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
    const status = loader.list().find((entry) => entry.name === "skill-distiller");
    if (status?.status !== "loaded") {
      throw new Error(`skill-distiller failed to load: ${status?.error ?? "no status"}`);
    }
  }

  async function endRun(stats: LoopAfterRun): Promise<void> {
    await (runtime.ctx.get("hooks") as HookBusService).waterfall<LoopAfterRun>("loop/after-run", stats);
    const distiller = runtime.ctx.get("skillDistiller") as { idle(): Promise<void> };
    await distiller.idle();
  }

  async function listSkillDirs(): Promise<string[]> {
    try {
      return await readdir(join(dir, ".flavorlite", "skills"));
    } catch {
      return [];
    }
  }

  async function writeSkill(slug: string, content: string): Promise<void> {
    const skillDir = join(dir, ".flavorlite", "skills", slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");
  }

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("distills a generated SKILL.md when a finished run passes the gates", async () => {
    await setup(VALID_REPLY);
    await endRun(finishedRun(10));

    expect(llmCalls).toHaveLength(1);
    expect(JSON.stringify(llmCalls[0]?.messages)).toContain("needle");

    const skillFile = join(dir, ".flavorlite", "skills", "deploy-to-staging", "SKILL.md");
    const content = await readFile(skillFile, "utf-8");
    expect(content).toContain("name: Deploy to staging");
    expect(content).toContain("generated: true");
    expect(content).toContain("run deploy script");
  });

  it("skips distillation when the run did not finish", async () => {
    await setup(VALID_REPLY);
    await endRun({ ...finishedRun(10), reason: "max_iterations" });

    expect(llmCalls).toHaveLength(0);
    expect(await listSkillDirs()).toHaveLength(0);
  });

  it("skips distillation for trivial runs", async () => {
    await setup(VALID_REPLY);
    await endRun(finishedRun(3));

    expect(llmCalls).toHaveLength(0);
    expect(await listSkillDirs()).toHaveLength(0);
  });

  it("honors the LLM skip decision", async () => {
    await setup(JSON.stringify({ skip: true, reason: "nothing reusable" }));
    await endRun(finishedRun(10));

    expect(llmCalls).toHaveLength(1);
    expect(await listSkillDirs()).toHaveLength(0);
  });

  it("never overwrites an existing skill slug and tells the LLM about it", async () => {
    await setup(VALID_REPLY);
    await writeSkill("deploy-to-staging", "---\nname: Deploy to staging\ndescription: human-written\n---\noriginal body");
    await endRun(finishedRun(10));

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]?.systemPrompt ?? "").toContain("deploy-to-staging");
    const content = await readFile(join(dir, ".flavorlite", "skills", "deploy-to-staging", "SKILL.md"), "utf-8");
    expect(content).toContain("original body");
  });

  it("stops distilling once maxGenerated is reached", async () => {
    await setup(VALID_REPLY, { maxGenerated: 1 });
    await writeSkill(
      "existing-generated",
      "---\nname: Existing\ndescription: already generated\ngenerated: true\n---\nbody",
    );
    await endRun(finishedRun(10));

    expect(llmCalls).toHaveLength(0);
    expect(await listSkillDirs()).toEqual(["existing-generated"]);
  });

  it("/distill lists generated skills and rm only removes generated ones", async () => {
    await setup(VALID_REPLY);
    await endRun(finishedRun(10));
    await writeSkill("human-skill", "---\nname: Human\ndescription: hand-written\n---\nbody");

    const commands = runtime.ctx.get("commands") as CommandsService;
    const listing = (await commands.execute("/distill")) ?? "";
    expect(listing).toContain("deploy-to-staging");
    expect(listing).toContain("human-skill");

    const refused = (await commands.execute("/distill rm human-skill")) ?? "";
    expect(refused.toLowerCase()).toContain("not generated");
    expect(await listSkillDirs()).toContain("human-skill");

    const removed = (await commands.execute("/distill rm deploy-to-staging")) ?? "";
    expect(removed.toLowerCase()).toContain("removed");
    expect(await listSkillDirs()).not.toContain("deploy-to-staging");
  });
});
