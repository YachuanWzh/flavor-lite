import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { promptPlugin, type PromptAssemble, type PromptService } from "../src/plugins/prompt";
import { environmentPlugin, guidancePlugins, identityPlugin } from "../src/plugins/guidance";
import { permissionPlugin } from "../src/plugins/permission";
import { toolsPlugin } from "../src/plugins/tools";
import { shellToolPlugin } from "../src/plugins/tools/builtin/shell";

/**
 * The prompt plugin is a pure assembler: every section is contributed by
 * another plugin through prompt/assemble. Mount no contributors, get an
 * empty system prompt; unmount a contributor, lose its section.
 */
describe("prompt assembly", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-lite-prompt-"));
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function assemble(): Promise<string> {
    const prompt = runtime.ctx.get("systemPrompt") as PromptService;
    return prompt.assemble();
  }

  it("is empty when no contributor is mounted", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin);
    runtime.start();
    expect(await assemble()).toBe("");
  });

  it("keeps section order = contributor mount order", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin);
    for (const plugin of guidancePlugins) runtime.use(plugin);
    runtime.start();

    const prompt = await assemble();
    const identity = prompt.indexOf("# Identity");
    const security = prompt.indexOf("# Security");
    const tasks = prompt.indexOf("# Tasks");
    const environment = prompt.indexOf("# Environment");
    for (const index of [identity, security, tasks, environment]) expect(index).toBeGreaterThan(-1);
    expect([identity, security, tasks, environment]).toEqual(
      [identity, security, tasks, environment].slice().sort((a, b) => a - b),
    );
    expect(prompt).toContain("Working directory");
  });

  it("loses a section when its plugin is not mounted", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin).use(identityPlugin); // security/tasks/environment omitted
    runtime.start();

    const prompt = await assemble();
    expect(prompt).toContain("# Identity");
    expect(prompt).not.toContain("# Security");
    expect(prompt).not.toContain("# Tasks");
    expect(prompt).not.toContain("# Environment");
  });

  it("deduplicates by name, keeping the last occurrence", async () => {
    const first = definePlugin({
      name: "dup:first",
      inject: ["hooks"],
      apply(ctx) {
        return ctx.effect(
          () =>
            (ctx.get("hooks") as HookBusService).hook<PromptAssemble>("prompt/assemble", async (event, next) => {
              event.sections.push({ name: "note", content: "first version" });
              return next(event);
            }),
          "dup:first.install",
        );
      },
    });
    const second = definePlugin({
      name: "dup:second",
      inject: ["hooks"],
      apply(ctx) {
        return ctx.effect(
          () =>
            (ctx.get("hooks") as HookBusService).hook<PromptAssemble>("prompt/assemble", async (event, next) => {
              event.sections.push({ name: "note", content: "second version" });
              return next(event);
            }),
          "dup:second.install",
        );
      },
    });

    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin).use(first).use(second);
    runtime.start();

    const prompt = await assemble();
    expect(prompt).toContain("second version");
    expect(prompt).not.toContain("first version");
  });

  it("permission plugin contributes a mode-aware section", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(toolsPlugin).use(promptPlugin).use(permissionPlugin, { mode: "plan" });
    runtime.start();

    const prompt = await assemble();
    expect(prompt).toContain("# Permissions");
    expect(prompt).toContain("plan (read-only)");
  });

  it("shell tool plugin contributes a platform-aware section", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(toolsPlugin).use(promptPlugin).use(shellToolPlugin);
    runtime.start();

    const prompt = await assemble();
    expect(prompt).toContain("# Shell");
    const expected = process.platform === "win32" ? "cmd.exe" : "$SHELL";
    expect(prompt).toContain(expected);
  });

  it("environment section stays runtime-derived", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin).use(environmentPlugin);
    runtime.start();

    const prompt = await assemble();
    expect(prompt).toContain(dir);
    expect(prompt).toContain(new Date().toISOString().slice(0, 10));
  });
});
