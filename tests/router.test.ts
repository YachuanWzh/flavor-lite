import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { toolsPlugin, type ToolRegistry, type AfterToolCall } from "../src/plugins/tools";
import { commandsPlugin } from "../src/plugins/commands";
import { promptPlugin } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService, type PluginStatus } from "../src/plugins/plugins";
import { routerPlugin, fingerprint, tokenize, type RouterPluginConfig } from "../src/plugins/router";
import type { AgentService, BeforeLoopRequest, LoopAfterRun } from "../src/plugins/loop";

/** The router injects "agent" for ordering; tests stub it. */
const stubAgentPlugin = definePlugin({
  name: "stub-agent",
  provides: ["agent"],
  apply(ctx) {
    const stub: AgentService = {
      run() {
        return (async function* () {
          /* no turns */
        })();
      },
      steer() {},
    };
    return ctx.effect(() => ctx.provide("agent", stub), "stub-agent.provide");
  },
});

/** Dynamic fixture: registers echo_tool, recalled via keyword "echo". */
const echoEntry = `
export default {
  name: "dyn-echo",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register({
      name: "echo_tool",
      description: "echo tool",
      category: "read",
      inputSchema: { type: "object" },
      async execute() { return { content: "echo!" }; },
    }), "dyn-echo.install");
  },
};
`;

const echoManifest = {
  name: "dyn-echo",
  activation: "dynamic",
  description: "echo utility for testing",
  triggers: { keywords: ["echo"], tools: ["echo_tool"] },
};

/** Dynamic fixture with no triggers: only the inverted index can find it. */
const weatherManifest = {
  name: "weather",
  activation: "dynamic",
  description: "fetches current weather forecast for a city",
};
const weatherEntry = `export default { name: "weather", apply() {} };`;

describe("router plugin", () => {
  let tmp: string;
  let pluginsRoot: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  async function writePlugin(dirName: string, manifest: unknown, entry: string): Promise<void> {
    const dir = join(pluginsRoot, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "flavor-plugin.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "index.js"), entry);
  }

  function createStack(config: RouterPluginConfig = {}): void {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(stubAgentPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false })
      .use(routerPlugin, config);
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
  }

  function status(name: string): PluginStatus {
    const entry = loader.list().find((candidate) => candidate.name === name);
    expect(entry, `plugin "${name}" should be in the catalog`).toBeDefined();
    return entry!;
  }

  function hooks(): HookBusService {
    return runtime.ctx.get("hooks") as HookBusService;
  }

  async function recall(input: string): Promise<BeforeLoopRequest> {
    const payload: BeforeLoopRequest = {
      messages: [{ role: "user", content: input }],
      systemPrompt: "",
      tools: [],
    };
    await hooks().waterfall<BeforeLoopRequest>("loop/before-request", payload);
    return payload;
  }

  async function endRun(): Promise<void> {
    await hooks().waterfall<LoopAfterRun>("loop/after-run", {
      iterations: 1,
      reason: "finished",
      toolCalls: 0,
      toolErrors: 0,
      steers: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flavor-router-"));
    pluginsRoot = join(tmp, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(tmp, { recursive: true, force: true });
  });

  describe("L0 deterministic recall", () => {
    it("recalls on keyword hit, announces it, and refreshes tool schemas", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();
      expect(status("dyn-echo").status).toBe("unloaded");

      const payload = await recall("please echo this back");

      expect(status("dyn-echo").status).toBe("loaded");
      const hint = payload.messages[payload.messages.length - 1];
      expect(hint?.role).toBe("user");
      expect(hint?.content).toContain("Plugins activated");
      expect(hint?.content).toContain("dyn-echo");
      expect(payload.tools.map((tool) => tool.name)).toContain("echo_tool");
    });

    it("does not recall on unrelated input", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();

      const payload = await recall("deploy the database cluster");

      expect(status("dyn-echo").status).toBe("unloaded");
      expect(payload.messages).toHaveLength(1);
      expect(payload.tools).toHaveLength(0);
    });

    it("isolates a plugin whose trigger pattern is an invalid regex", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      await writePlugin(
        "bad-pattern",
        { name: "bad-pattern", activation: "dynamic", triggers: { patterns: ["["] } },
        "export default { name: 'bad-pattern', apply() {} };",
      );
      createStack();
      await loader.init();

      expect(status("bad-pattern").status).toBe("error");
      expect(status("bad-pattern").error).toMatch(/invalid triggers\.patterns/);
      // The healthy plugin still recalls fine.
      await recall("please echo this");
      expect(status("dyn-echo").status).toBe("loaded");
    });
  });

  describe("routing once per input", () => {
    it("routes the same input once per run and again on the next run", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();

      const first = await recall("please echo this back");
      expect(status("dyn-echo").status).toBe("loaded");
      expect(first.messages.filter((message) => message.content.includes("Plugins activated"))).toHaveLength(1);

      // Second iteration of the same run, same input: no re-routing, so no
      // duplicate announcement and no junk recalled against the leftovers.
      const second = await recall("please echo this back");
      expect(second.messages.filter((message) => message.content.includes("Plugins activated"))).toHaveLength(0);

      // After the run ends the same input routes again on a new turn.
      await endRun();
      expect(status("dyn-echo").status).toBe("unloaded");
      const third = await recall("please echo this back");
      expect(status("dyn-echo").status).toBe("loaded");
      expect(third.messages.some((message) => message.content.includes("Plugins activated"))).toBe(true);
    });
  });

  describe("L1 inverted-index recall", () => {
    it("recalls on description token overlap above minScore", async () => {
      await writePlugin("weather", weatherManifest, weatherEntry);
      createStack();
      await loader.init();

      await recall("what is the weather forecast today");

      expect(status("weather").status).toBe("loaded");
    });

    it("honors minScore", async () => {
      await writePlugin("weather", weatherManifest, weatherEntry);
      createStack({ minScore: 5 });
      await loader.init();

      await recall("what is the weather forecast today");

      expect(status("weather").status).toBe("unloaded");
    });

    it("does not recall on single CJK char overlap alone", async () => {
      // The keyword "分步" shares the single char "分" with the query; single
      // CJK chars carry no identity and must not trigger a recall.
      await writePlugin(
        "planner",
        {
          name: "planner",
          activation: "dynamic",
          description: "任务规划与分步执行",
          triggers: { keywords: ["任务规划", "分步"] },
        },
        "export default { name: 'planner', apply() {} };",
      );
      createStack();
      await loader.init();

      await recall("帮我用ast分析下这个项目");

      expect(status("planner").status).toBe("unloaded");
    });
  });

  describe("L2 tool-name fallback", () => {
    it("mounts the declaring plugin when an unknown tool is called", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();

      const tools = runtime.ctx.get("tools") as ToolRegistry;
      const result = await tools.execute({ id: "t1", name: "echo_tool", args: {} }, { cwd: tmp });

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe("echo!");
      expect(status("dyn-echo").status).toBe("loaded");
    });
  });

  describe("ejection after the run", () => {
    it("ejects a dynamic plugin that was not used this turn", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();
      await loader.ensure("dyn-echo");
      const tools = runtime.ctx.get("tools") as ToolRegistry;
      expect(tools.get("echo_tool")).toBeDefined();

      await endRun();

      expect(status("dyn-echo").status).toBe("unloaded");
      expect(tools.get("echo_tool")).toBeUndefined();
    });

    it("keeps a plugin whose tools ran this turn", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();
      await loader.ensure("dyn-echo");

      await hooks().waterfall<AfterToolCall>("tools/after-call", {
        toolCall: { id: "t1", name: "echo_tool", args: {} },
        args: {},
        result: { content: "echo!" },
      });
      await endRun();

      expect(status("dyn-echo").status).toBe("loaded");
    });

    it("keeps a plugin that another loaded plugin depends on", async () => {
      await writePlugin(
        "dyn-svc",
        { name: "dyn-svc", activation: "dynamic", provides: ["svc"], description: "provides the svc service" },
        `export default {
          name: "dyn-svc",
          provides: ["svc"],
          apply(ctx) { return ctx.effect(() => ctx.provide("svc", { ok: true }), "dyn-svc.provide"); },
        };`,
      );
      await writePlugin(
        "dyn-dep",
        { name: "dyn-dep", activation: "dynamic", description: "consumes svc" },
        `export default {
          name: "dyn-dep",
          inject: ["svc"],
          apply(ctx) { ctx.get("svc"); },
        };`,
      );
      createStack();
      await loader.init();

      // ensure() resolves the dependency recursively from manifest provides.
      await loader.ensure("dyn-dep");
      expect(status("dyn-svc").status).toBe("loaded");
      expect(status("dyn-dep").status).toBe("loaded");

      await endRun();

      expect(status("dyn-dep").status).toBe("unloaded"); // idle: ejected
      expect(status("dyn-svc").status).toBe("loaded"); // depended on: kept
    });

    it("never ejects pinned or eager plugins", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      await writePlugin(
        "eager-demo",
        { name: "eager-demo" },
        `export default { name: "eager-demo", inject: ["tools"], apply(ctx) {
          return ctx.effect(() => ctx.get("tools").register({
            name: "demo_tool", description: "demo", category: "read",
            inputSchema: { type: "object" }, async execute() { return { content: "demo" }; },
          }), "eager-demo.install");
        } };`,
      );
      createStack({ pinned: ["dyn-echo"] });
      await loader.init();
      await loader.ensure("dyn-echo");

      await endRun();

      expect(status("dyn-echo").status).toBe("loaded"); // pinned
      expect(status("eager-demo").status).toBe("loaded"); // eager
    });
  });

  describe("adaptive feedback", () => {
    it("records unused recalls and demotes them on the next similar request", async () => {
      await writePlugin("weather", weatherManifest, weatherEntry);
      createStack(); // feedback on by default
      await loader.init();

      await recall("what is the weather forecast today");
      expect(status("weather").status).toBe("loaded");
      await endRun(); // unused -> ejected + memory entry used:false
      expect(status("weather").status).toBe("unloaded");

      const memoryPath = join(tmp, ".flavorlite", "router-memory.json");
      const memory = JSON.parse(await readFile(memoryPath, "utf-8")) as Array<{ plugin: string; used: boolean }>;
      expect(memory).toHaveLength(1);
      expect(memory[0]).toMatchObject({ plugin: "weather", used: false });

      // Same request again: the penalty pushes the score below minScore.
      await recall("what is the weather forecast today");
      expect(status("weather").status).toBe("unloaded");
    });

    it("boosts plugins with a matching used history", async () => {
      await writePlugin("weather", weatherManifest, weatherEntry);
      const memoryPath = join(tmp, ".flavorlite", "router-memory.json");
      await mkdir(join(tmp, ".flavorlite"), { recursive: true });
      await writeFile(
        memoryPath,
        JSON.stringify([{ fp: ["forecast", "weather"], plugin: "weather", used: true }]),
      );
      // Base L1 score (~2.1) fails minScore 3; the +2 boost lifts it over.
      createStack({ minScore: 3 });
      await loader.init();

      await recall("what is the weather forecast today");

      expect(status("weather").status).toBe("loaded");
    });

    it("caps the memory file", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      const memoryPath = join(tmp, ".flavorlite", "router-memory.json");
      await mkdir(join(tmp, ".flavorlite"), { recursive: true });
      const seed = Array.from({ length: 250 }, (_, index) => ({ fp: ["t"], plugin: `p${index}`, used: true }));
      await writeFile(memoryPath, JSON.stringify(seed));
      createStack();
      await loader.init();

      await recall("please echo this");
      await endRun(); // appends one entry, then trims

      const memory = JSON.parse(await readFile(memoryPath, "utf-8")) as unknown[];
      expect(memory).toHaveLength(200);
    });
    it("ignores poisoned entries whose fingerprint barely overlaps", async () => {
      await writePlugin("weather", weatherManifest, weatherEntry);
      const memoryPath = join(tmp, ".flavorlite", "router-memory.json");
      await mkdir(join(tmp, ".flavorlite"), { recursive: true });
      // Legacy poisoned entry: mostly ubiquitous tokens (single CJK chars,
      // plus one unrelated ascii token).
      await writeFile(
        memoryPath,
        JSON.stringify([{ fp: ["city", "一", "个", "帮"], plugin: "weather", used: false }]),
      );
      createStack();
      await loader.init();

      await recall("what is the weather forecast today");

      expect(status("weather").status).toBe("loaded");
    });

    it("drops single CJK chars from fingerprints", () => {
      const fp = fingerprint(tokenize("派生一个子agent探索一下这个项目"));
      expect(fp).not.toContain("一");
      expect(fp).not.toContain("子");
      expect(fp).toContain("agent");
      expect(fp).toContain("探索");
    });

    it("drops structural bigrams from fingerprints", () => {
      const fp = fingerprint(tokenize("帮我用ast分析下这个项目"));
      expect(fp).toContain("ast");
      expect(fp).toContain("分析");
      expect(fp).toContain("项目");
      expect(fp).not.toContain("帮我");
      expect(fp).not.toContain("我用");
      expect(fp).not.toContain("这个");
      expect(fp).not.toContain("个项");
      expect(fp).not.toContain("析下");
    });

    it("never records negative feedback for L0 keyword recalls", async () => {
      await writePlugin("dyn-echo", echoManifest, echoEntry);
      createStack();
      await loader.init();
      const memoryPath = join(tmp, ".flavorlite", "router-memory.json");

      // Recalled via the author-declared keyword "echo" but never used: the
      // model not calling the tool is no evidence against an L0 recall.
      await recall("please echo this back");
      expect(status("dyn-echo").status).toBe("loaded");
      await endRun();
      const memory = JSON.parse(await readFile(memoryPath, "utf-8")) as Array<{ plugin: string; used: boolean }>;
      expect(memory.filter((entry) => entry.plugin === "dyn-echo")).toHaveLength(0);

      // Used recalls still record a positive entry (boosts keep working).
      await recall("please echo this back");
      await hooks().waterfall<AfterToolCall>("tools/after-call", {
        toolCall: { id: "t1", name: "echo_tool", args: {} },
        args: {},
        result: { content: "echo!" },
      });
      await endRun();
      const updated = JSON.parse(await readFile(memoryPath, "utf-8")) as Array<{ plugin: string; used: boolean }>;
      expect(updated).toContainEqual(expect.objectContaining({ plugin: "dyn-echo", used: true }));
    });
  });
});
