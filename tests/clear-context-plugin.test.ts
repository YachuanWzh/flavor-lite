import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import { sessionPlugin, type SessionService } from "../src/plugins/session";
import type { BeforeLoopRequest } from "../src/plugins/loop";

/**
 * The plugin under test is loaded the way a user loads it: through the
 * plugins loader, from the real .flavorlite/plugins/clear-context/ directory
 * (copied into an isolated temp root so the other disk plugins stay out).
 */
const PLUGIN_SOURCE = fileURLToPath(new URL("../.flavorlite/plugins/clear-context", import.meta.url));

describe("clear-context plugin", () => {
  let dir: string;
  let pluginsRoot: string;
  let runtime: Runtime;
  let loader: PluginsLoaderService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-clear-context-"));
    pluginsRoot = join(dir, ".flavorlite", "plugins");
    const target = join(pluginsRoot, "clear-context");
    await mkdir(target, { recursive: true });
    for (const file of await readdir(PLUGIN_SOURCE)) {
      await writeFile(join(target, file), await readFile(join(PLUGIN_SOURCE, file), "utf-8"));
    }

    runtime = Runtime.create({ cwd: dir });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(sessionPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
    runtime.start();
    loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function hooks(): HookBusService {
    return runtime.ctx.get("hooks") as HookBusService;
  }

  function commands(): CommandsService {
    return runtime.ctx.get("commands") as CommandsService;
  }

  function sessions(): SessionService {
    return runtime.ctx.get("session") as SessionService;
  }

  async function beforeRequest(messages: BeforeLoopRequest["messages"]): Promise<BeforeLoopRequest["messages"]> {
    const payload = await hooks().waterfall<BeforeLoopRequest>("loop/before-request", {
      messages,
      systemPrompt: "sys",
      tools: [],
    });
    return payload.messages;
  }

  it("loads and registers /clear with a clear-screen sequence", async () => {
    const status = loader.list().find((entry) => entry.name === "clear-context");
    expect(status?.status).toBe("loaded");

    const output = await commands().execute("/clear");
    expect(output).toContain("\x1b[2J\x1b[H");
    expect(output).toContain("context cleared");
  });

  it("rewrites the session file to only the header and hides pre-clear messages", async () => {
    const handle = await sessions().create({ model: "fake:fake-1" });
    await handle.append({ role: "user", content: "old q1" });
    await handle.append({ role: "assistant", content: "old a1" });
    await handle.append({ role: "user", content: "old q2" });

    await commands().execute("/clear");

    // Persisted log now keeps only the header line.
    const raw = await readFile(join(sessions().dir, `${handle.id}.jsonl`), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"type":"header"');

    // The loop appends every message before the request fires; the in-memory
    // history still carries the pre-clear messages, so the hook must slice
    // them off the outgoing request.
    await handle.append({ role: "user", content: "new q" });
    const visible = await beforeRequest(handle.messages());
    expect(visible).toEqual([{ role: "user", content: "new q" }]);

    // Trimming stays active on later requests of the same in-memory session.
    await handle.append({ role: "assistant", content: "new a" });
    const later = await beforeRequest(handle.messages());
    expect(later).toEqual([
      { role: "user", content: "new q" },
      { role: "assistant", content: "new a" },
    ]);
  });

  it("keeps a history shorter than the clear point intact (resumed session)", async () => {
    const handle = await sessions().create();
    await handle.append({ role: "user", content: "old" });
    await commands().execute("/clear"); // file rewritten to header

    // /resume re-reads the rewritten file: only post-clear messages remain.
    const reopened = await sessions().open(handle.id);
    await reopened.append({ role: "user", content: "after clear" });

    const visible = await beforeRequest(reopened.messages());
    expect(visible).toEqual([{ role: "user", content: "after clear" }]);
  });

  it("does not over-trim after re-opening a session with many post-clear messages", async () => {
    const handle = await sessions().create();
    await handle.append({ role: "user", content: "old" });
    await commands().execute("/clear");

    // Post-clear conversation outgrows the pre-clear history while the
    // original in-memory handle still carries the old message.
    await handle.append({ role: "user", content: "p1" });
    await handle.append({ role: "assistant", content: "p2" });

    // /resume re-reads the rewritten file: old message gone, post-clear kept.
    const reopened = await sessions().open(handle.id);
    await reopened.append({ role: "user", content: "q" });
    const visible = await beforeRequest(reopened.messages());
    expect(visible).toEqual([
      { role: "user", content: "p1" },
      { role: "assistant", content: "p2" },
      { role: "user", content: "q" },
    ]);
  });

  it("falls back to the newest user message when nothing post-clear exists yet", async () => {
    const handle = await sessions().create();
    await handle.append({ role: "user", content: "q" });
    await handle.append({ role: "assistant", content: "a" });
    await commands().execute("/clear"); // file rewritten to header

    // Request fired before any new message was logged: everything is
    // pre-clear, but the request must still carry a user message to stay
    // valid, so only the newest one is surfaced.
    const visible = await beforeRequest(handle.messages());
    expect(visible).toEqual([{ role: "user", content: "q" }]);
  });
});
