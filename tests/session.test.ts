import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { sessionPlugin, type SessionService } from "../src/plugins/session";

describe("session plugin", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-lite-session-test-"));
    runtime = Runtime.create({ cwd: dir });
    runtime.use(sessionPlugin).start();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists messages as JSONL and reopens them fully", async () => {
    const sessions = runtime.ctx.get("session") as SessionService;
    const handle = await sessions.create({ model: "fake:fake-1" });
    await handle.append({ role: "user", content: "hello" });
    await handle.append({ role: "assistant", content: "hi there" });
    await handle.setTitle("greeting session");

    const reopened = await sessions.open(handle.id);
    expect(reopened.messages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(reopened.title()).toBe("greeting session");
  });

  it("lists sessions newest first with title and counts", async () => {
    const sessions = runtime.ctx.get("session") as SessionService;
    const older = await sessions.create();
    await older.append({ role: "user", content: "old" });
    await new Promise((resolve) => setTimeout(resolve, 30)); // distinct mtimes
    const newer = await sessions.create();
    await newer.setTitle("newer one");

    const infos = await sessions.list();
    expect(infos.length).toBe(2);
    expect(infos[0]!.id).toBe(newer.id);
    expect(infos[0]!.title).toBe("newer one");
    expect(infos[1]!.messageCount).toBe(1);
  });

  it("quarantines torn trailing lines instead of failing the reopen", async () => {
    const sessions = runtime.ctx.get("session") as SessionService;
    const handle = await sessions.create();
    await handle.append({ role: "user", content: "survivor" });
    // Simulate a crash mid-write: append a truncated JSON line.
    const file = join(sessions.dir, `${handle.id}.jsonl`);
    await appendFile(file, '{"type":"message","message":{"role":"user","conte\n', "utf-8");

    const reopened = await sessions.open(handle.id);
    expect(reopened.messages()).toEqual([{ role: "user", content: "survivor" }]);
  });

  it("latest() tracks the most recently updated session", async () => {
    const sessions = runtime.ctx.get("session") as SessionService;
    expect(await sessions.latest()).toBeUndefined();
    const handle = await sessions.create();
    await handle.append({ role: "user", content: "touch" });
    expect(await sessions.latest()).toBe(handle.id);
  });

  it("rejects invalid session ids", async () => {
    const sessions = runtime.ctx.get("session") as SessionService;
    await expect(sessions.open("../escape")).rejects.toThrow(/invalid session id/);
  });
});
