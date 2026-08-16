import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin } from "../src/plugins/hooks";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";
import { commandsPlugin } from "../src/plugins/commands";
import { promptPlugin } from "../src/plugins/prompt";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import { editToolPlugin, readToolPlugin, writeToolPlugin } from "../src/plugins/tools/builtin/files";
import { shellToolPlugin } from "../src/plugins/tools/builtin/shell";

/**
 * Loads the real disk plugin from .flavorlite/plugins/filediff through the
 * plugins loader (the same path a user gets with /plugin list), then drives
 * the built-in file tools through the registry so the before/after hooks run.
 */
describe("filediff plugin", () => {
  const pluginSrc = join(process.cwd(), ".flavorlite", "plugins", "filediff");

  let tmp: string;
  let pluginsRoot: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  async function copyPlugin(manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const dir = join(pluginsRoot, "filediff");
    await mkdir(dir, { recursive: true });
    const manifest = {
      ...JSON.parse(await readFile(join(pluginSrc, "flavor-plugin.json"), "utf-8")),
      ...manifestOverrides,
    };
    await writeFile(join(dir, "flavor-plugin.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "index.js"), await readFile(join(pluginSrc, "index.js"), "utf-8"));
  }

  function createStack(): void {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(toolsPlugin)
      .use(commandsPlugin)
      .use(promptPlugin)
      .use(readToolPlugin)
      .use(writeToolPlugin)
      .use(editToolPlugin)
      .use(shellToolPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
  }

  /** Execute one tool call and return everything the plugin wrote to stdout. */
  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tools = runtime.ctx.get("tools") as ToolRegistry;
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured += String(chunk ?? "");
      return true;
    });
    try {
      const result = await tools.execute({ id: `t-${name}-${Math.random()}`, name, args }, { cwd: tmp });
      expect(result.isError).not.toBe(true);
    } finally {
      spy.mockRestore();
    }
    return captured;
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flavor-filediff-"));
    pluginsRoot = join(tmp, ".flavorlite", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads cleanly through the plugins loader", async () => {
    await copyPlugin();
    createStack();
    await loader.init();
    const status = loader.list().find((entry) => entry.name === "filediff");
    expect(status?.status).toBe("loaded");
  });

  it("shows a new file as green '+ line' entries", async () => {
    await copyPlugin({ config: { color: "always" } });
    createStack();
    await loader.init();

    const output = await runTool("Write", { path: "new.txt", content: "hello\nworld\n" });

    expect(output).toContain("new (+2)");
    expect(output).toContain(`\u001b[32m+ hello\u001b[0m`);
    expect(output).toContain(`\u001b[32m+ world\u001b[0m`);
    expect(output).not.toContain("- ");
  });

  it("shows an edit as red '- line' then green '+ line' on separate lines", async () => {
    await copyPlugin({ config: { color: "always" } });
    createStack();
    await loader.init();
    await writeFile(join(tmp, "a.txt"), "alpha\nbeta\ngamma\n", "utf-8");

    const output = await runTool("Edit", { path: "a.txt", oldText: "beta", newText: "BETA" });

    expect(output).toContain("modified (+1 −1)");
    expect(output).toContain(`\u001b[31m- beta\u001b[0m`);
    expect(output).toContain(`\u001b[32m+ BETA\u001b[0m`);
    // removals come before additions in the same change block
    expect(output.indexOf("- beta")).toBeLessThan(output.indexOf("+ BETA"));
    // untouched lines are not echoed
    expect(output).not.toContain("alpha");
    expect(output).not.toContain("gamma");
  });

  it("shows an overwrite (existing file) as a modified diff", async () => {
    await copyPlugin();
    createStack();
    await loader.init();
    await writeFile(join(tmp, "b.txt"), "one\ntwo\n", "utf-8");

    const output = await runTool("Write", { path: "b.txt", content: "one\nthree\n" });

    expect(output).toContain("modified (+1 −1)");
    expect(output).toContain("\n- two\n");
    expect(output).toContain("\n+ three\n");
  });

  it("shows a deleted file as red '- line' entries", async () => {
    await copyPlugin();
    createStack();
    await loader.init();
    await writeFile(join(tmp, "del.txt"), "gone1\ngone2\n", "utf-8");

    const rm = process.platform === "win32" ? "del del.txt" : "rm del.txt";
    const output = await runTool("Shell", { command: rm });

    expect(output).toContain("deleted (-2)");
    expect(output).toContain("\n- gone1\n");
    expect(output).toContain("\n- gone2\n");
  });

  it("emits nothing for read-only tool calls", async () => {
    await copyPlugin();
    createStack();
    await loader.init();
    await writeFile(join(tmp, "r.txt"), "hello\n", "utf-8");

    const output = await runTool("Read", { path: "r.txt" });

    expect(output).toBe("");
  });

  it("emits nothing when a write tool errors", async () => {
    await copyPlugin();
    createStack();
    await loader.init();

    const tools = runtime.ctx.get("tools") as ToolRegistry;
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured += String(chunk ?? "");
      return true;
    });
    try {
      const result = await tools.execute(
        { id: "t-edit-missing", name: "Edit", args: { path: "nope.txt", oldText: "x", newText: "y" } },
        { cwd: tmp },
      );
      expect(result.isError).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(captured).toBe("");
  });
});
