import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin } from "../src/plugins/hooks";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { promptPlugin, type PromptService } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";

/** ESM fixture: registers a tool, a command, and a prompt section. */
const demoEntry = (version: string) => `
export default {
  name: "demo",
  inject: ["hooks", "tools", "commands"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposers = [];
      disposers.push(ctx.get("tools").register({
        name: "demo_tool",
        description: "demo tool ${version}",
        category: "read",
        inputSchema: { type: "object" },
        async execute() { return { content: "demo ${version}" }; },
      }));
      disposers.push(ctx.get("commands").register({
        name: "demo",
        description: "demo command",
        run: () => "demo says ${version}",
      }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        event.sections.push({ name: "demo", content: "demo section ${version}" });
        return next(event);
      }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "demo.install");
  },
};
`;

describe("plugins loader", () => {
  let tmp: string;
  let pluginsRoot: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  async function writePlugin(dirName: string, manifest: unknown, entry: string): Promise<string> {
    const dir = join(pluginsRoot, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "flavor-plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    await writeFile(join(dir, "index.js"), entry);
    return dir;
  }

  function createStack(): void {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot] });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flavor-plugins-"));
    // Same layout scaffold() writes to, so generated plugins are discoverable.
    pluginsRoot = join(tmp, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads a valid disk plugin: tool, command, and prompt section", async () => {
    await writePlugin("demo", { name: "demo", version: "1.2.3" }, demoEntry("v1"));
    createStack();
    await loader.init();

    const tools = runtime.ctx.get("tools") as ToolRegistry;
    const commands = runtime.ctx.get("commands") as CommandsService;
    const prompt = runtime.ctx.get("systemPrompt") as PromptService;

    expect(tools.get("demo_tool")?.description).toBe("demo tool v1");
    expect(await commands.execute("/demo")).toBe("demo says v1");
    expect(await prompt.assemble()).toContain("demo section v1");

    const status = loader.list().find((entry) => entry.name === "demo");
    expect(status?.status).toBe("loaded");
    expect(status?.version).toBe("1.2.3");
  });

  it("isolates broken plugins without crashing the host", async () => {
    await writePlugin("demo", { name: "demo" }, demoEntry("v1"));
    // Invalid manifest JSON.
    await mkdir(join(pluginsRoot, "broken-manifest"), { recursive: true });
    await writeFile(join(pluginsRoot, "broken-manifest", "flavor-plugin.json"), "{ nope");
    // Entry with a syntax error.
    await writePlugin("bad-import", { name: "bad-import" }, "export default {");
    // Entry without a default export.
    await writePlugin("no-default", { name: "no-default" }, "export const notAPlugin = 1;");
    createStack();
    await loader.init();

    const byName = new Map(loader.list().map((entry) => [entry.name, entry]));
    expect(byName.get("demo")?.status).toBe("loaded");
    expect(byName.get("broken-manifest")?.status).toBe("error");
    expect(byName.get("broken-manifest")?.error).toMatch(/invalid flavor-plugin\.json/);
    expect(byName.get("bad-import")?.status).toBe("error");
    expect(byName.get("bad-import")?.error).toMatch(/import failed/);
    expect(byName.get("no-default")?.status).toBe("error");
    expect(byName.get("no-default")?.error).toMatch(/default export/);
    // The healthy plugin still works.
    const tools = runtime.ctx.get("tools") as ToolRegistry;
    expect(tools.get("demo_tool")).toBeDefined();
  });

  it("reload re-imports the entry and removes the previous registrations", async () => {
    await writePlugin("demo", { name: "demo" }, demoEntry("v1"));
    createStack();
    await loader.init();

    const tools = runtime.ctx.get("tools") as ToolRegistry;
    const commands = runtime.ctx.get("commands") as CommandsService;
    expect(tools.get("demo_tool")?.description).toBe("demo tool v1");

    await writePlugin("demo", { name: "demo" }, demoEntry("v2"));
    await loader.reload("demo");

    expect(tools.get("demo_tool")?.description).toBe("demo tool v2");
    expect(await commands.execute("/demo")).toBe("demo says v2");
    // Exactly one registration survives — the old one was unmounted.
    expect(tools.list().filter((tool) => tool.name === "demo_tool")).toHaveLength(1);
  });

  it("reload without a name discovers newly added plugin dirs", async () => {
    await writePlugin("demo", { name: "demo" }, demoEntry("v1"));
    createStack();
    await loader.init();
    expect(loader.list()).toHaveLength(1);

    await writePlugin("late", { name: "late" }, `
export default {
  name: "late",
  inject: ["commands"],
  apply(ctx) {
    return ctx.effect(
      () => ctx.get("commands").register({ name: "late", description: "late", run: () => "late!" }),
      "late.install",
    );
  },
};
`);
    await loader.reload();
    expect(loader.list().map((entry) => entry.name).sort()).toEqual(["demo", "late"]);
    const commands = runtime.ctx.get("commands") as CommandsService;
    expect(await commands.execute("/late")).toBe("late!");
  });

  it("reload reports errors without leaving stale registrations", async () => {
    await writePlugin("demo", { name: "demo" }, demoEntry("v1"));
    createStack();
    await loader.init();
    const tools = runtime.ctx.get("tools") as ToolRegistry;
    expect(tools.get("demo_tool")).toBeDefined();

    await writePlugin("demo", { name: "demo" }, "export default {"); // broken
    await loader.reload("demo");

    expect(loader.list().find((entry) => entry.name === "demo")?.status).toBe("error");
    expect(tools.get("demo_tool")).toBeUndefined(); // old version unmounted
  });

  it("scaffold creates a plugin that loads and registers its command", async () => {
    createStack();
    const dir = await loader.scaffold("gen");
    expect(dir).toBe(join(tmp, ".flavorlite", "plugins", "gen"));

    await loader.reload("gen");
    const status = loader.list().find((entry) => entry.name === "gen");
    expect(status?.status).toBe("loaded");

    const commands = runtime.ctx.get("commands") as CommandsService;
    expect(await commands.execute("/gen")).toBe("Hello from the gen plugin!");
    const tools = runtime.ctx.get("tools") as ToolRegistry;
    expect(tools.get("gen_hello")?.name).toBe("gen_hello");
  });

  it("rejects scaffolding over an existing dir and invalid names", async () => {
    createStack();
    await loader.scaffold("gen");
    await expect(loader.scaffold("gen")).rejects.toThrow(/already exists/);
    await expect(loader.scaffold("9bad")).rejects.toThrow(/invalid plugin name/);
  });

  it("exposes the /plugin command for list and reload", async () => {
    await writePlugin("demo", { name: "demo" }, demoEntry("v1"));
    createStack();
    await loader.init();
    const commands = runtime.ctx.get("commands") as CommandsService;

    const list = await commands.execute("/plugin list");
    expect(list).toContain("demo");
    expect(list).toContain("loaded");

    const reloaded = await commands.execute("/plugin reload demo");
    expect(reloaded).toContain("reloaded: demo");

    const unknown = await commands.execute("/plugin reload ghost");
    expect(unknown).toMatch(/error|not found/);
  });
});
