import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry, RingLog } from "./index.js";

test("ring log exposes incremental cursors after truncation", () => {
  const log = new RingLog(5);
  log.append("abc");
  log.append("def");
  assert.deepEqual(log.read(0), { cursor: 6, baseCursor: 1, text: "bcdef", truncated: true });
  assert.equal(log.read(4).text, "ef");
});

test("starts, polls and observes a short child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "proc-manager-"));
  const registry = new ProcessRegistry({ cwd, maxProcesses: 2, maxOutputChars: 1000 });
  const started = registry.start({ command: `"${process.execPath}" -e "console.log('ready')"`, label: "dev" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const polled = registry.poll(started.id, 0);
  assert.match(polled.output, /ready/);
  assert.equal(polled.state, "exited");
  const live = registry.start({ command: `"${process.execPath}" -e "setTimeout(()=>{}, 1000)"`, label: "live" });
  assert.throws(() => registry.start({ command: "x", label: "live" }), /label/);
  await registry.stop(live.id);
  await registry.dispose();
});
