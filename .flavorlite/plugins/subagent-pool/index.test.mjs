import test from "node:test";
import assert from "node:assert/strict";
import { runPool } from "./index.js";

test("pool is bounded and preserves task order", async () => {
  let active = 0;
  let peak = 0;
  const runner = async ({ task }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, task === "slow" ? 30 : 5));
    active -= 1;
    return { content: task };
  };
  const result = await runPool([{ task: "slow" }, { task: "fast" }, { task: "last" }], { maxConcurrency: 2, runner });
  assert.equal(peak, 2);
  assert.deepEqual(result.map((entry) => entry.content), ["slow", "fast", "last"]);
});

test("fail-fast does not schedule remaining tasks", async () => {
  const called = [];
  const runner = async ({ task }) => { called.push(task); return task === "bad" ? { content: "bad", isError: true } : { content: task }; };
  const result = await runPool([{ task: "bad" }, { task: "later" }], { maxConcurrency: 1, failFast: true, runner });
  assert.deepEqual(called, ["bad"]);
  assert.equal(result[1].skipped, true);
});
