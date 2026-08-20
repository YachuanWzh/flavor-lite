import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { applyTransaction, planTransaction } from "./index.js";

test("registers a snake_case write tool", () => {
  const registered = [];
  const services = {
    tools: { register(value) { registered.push(value); return () => {}; } },
    hooks: { hook() { return () => {}; } },
  };
  const ctx = { get(name) { return services[name]; }, effect(setup) { return setup(); } };
  const dispose = plugin.apply(ctx, {});
  assert.equal(registered[0]?.name, "apply_patch_transaction");
  assert.equal(registered[0]?.category, "write");
  dispose();
});

test("applies multiple operations as one transaction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "change-tx-"));
  await writeFile(join(cwd, "a.txt"), "before\n");
  const result = await applyTransaction(cwd, [
    { op: "replace", path: "a.txt", oldText: "before", newText: "after" },
    { op: "create", path: "b.txt", content: "new\n" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "new\n");
});

test("a stale precondition leaves every file untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "change-tx-"));
  await writeFile(join(cwd, "a.txt"), "A");
  await writeFile(join(cwd, "b.txt"), "B");
  await assert.rejects(() => applyTransaction(cwd, [
    { op: "replace", path: "a.txt", oldText: "A", newText: "AA" },
    { op: "replace", path: "b.txt", oldText: "stale", newText: "BB" },
  ]), /not found/);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "A");
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "B");
});

test("planner rejects workspace escapes and ambiguous replacements", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "change-tx-"));
  await writeFile(join(cwd, "a.txt"), "x x");
  await assert.rejects(() => planTransaction(cwd, [{ op: "create", path: "../escape", content: "x" }]), /escapes/);
  await assert.rejects(() => planTransaction(cwd, [{ op: "replace", path: "a.txt", oldText: "x", newText: "y" }]), /2 locations/);
});
