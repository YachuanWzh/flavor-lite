import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import plugin, { createCheckpoint, parsePorcelainZ, restoreCheckpoint } from "./index.js";

test("parses ordinary and renamed porcelain records", () => {
  const rows = parsePorcelainZ(" M a.txt\0R  new.txt\0old.txt\0?? u.txt\0");
  assert.deepEqual(rows.map((row) => [row.code, row.path, row.originalPath]), [
    [" M", "a.txt", undefined], ["R ", "new.txt", "old.txt"], ["??", "u.txt", undefined],
  ]);
});

test("checkpoint restore returns files to their captured state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-safety-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "base");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "before-agent");
  const checkpoint = await createCheckpoint(cwd, "before work");
  await writeFile(join(cwd, "tracked.txt"), "after-agent");
  await writeFile(join(cwd, "new.txt"), "new");
  await restoreCheckpoint(cwd, checkpoint.id);
  assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "before-agent");
  await assert.rejects(() => readFile(join(cwd, "new.txt")), /ENOENT/);
});

test("checkpoint creation is permissioned as a write tool", () => {
  const registrations = [];
  const services = {
    tools: { register(value) { registrations.push(value); return () => {}; }, get() {} },
    commands: { register() { return () => {}; } },
    hooks: { hook() { return () => {}; } },
  };
  const ctx = {
    cwd: process.cwd(), get(name) { return services[name]; },
    effect(setup) { return setup(); },
  };
  const dispose = plugin.apply(ctx, {});
  assert.equal(registrations.find((tool) => tool.name === "git_checkpoint")?.category, "write");
  dispose();
});
