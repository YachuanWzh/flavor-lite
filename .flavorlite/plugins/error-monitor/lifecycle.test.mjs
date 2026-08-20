import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index.js";

test("async disposer drains queued distillation before resolving", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "error-monitor-life-"));
  let afterCall;
  let releaseStream;
  let markStarted;
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  const streamStarted = new Promise((resolve) => { markStarted = resolve; });
  const services = {
    hooks: { hook(name, handler) { if (name === "tools/after-call") afterCall = handler; return () => {}; } },
    commands: { register() { return () => {}; } },
    memory: { store: { async rememberForTask() { return { added: true }; } } },
    llm: { async *stream() { markStarted(); await streamGate; yield { type: "text_delta", text: '{"analysis":"use a valid command","confidence":0.9}' }; } },
  };
  const ctx = {
    cwd,
    logger: { info() {}, warn() {}, debug() {} },
    get(name) { return services[name]; },
    tryGet(name) { return services[name]; },
    effect(setup) { return setup(); },
  };
  try {
    const dispose = plugin.apply(ctx, { llm: { enabled: true, timeoutMs: 0, retryCount: 0, confidenceThreshold: 0.7 } });
    await afterCall({ toolCall: { name: "Shell", args: { command: "bad" } }, args: { command: "bad" }, result: { content: "[exit code: 1]", isError: true } }, async (event) => event);
    await streamStarted;
    let resolved = false;
    const stopping = Promise.resolve(dispose()).then(() => { resolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    releaseStream();
    await stopping;
    assert.equal(resolved, true);
  } finally {
    releaseStream?.();
    await rm(cwd, { recursive: true, force: true });
  }
});
