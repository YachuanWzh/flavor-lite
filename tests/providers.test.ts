import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { createAgent, type AgentHandle } from "../src/host/bootstrap";
import { llmPlugin, type LlmService } from "../src/plugins/llm";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/plugins/llm/types";
import { anthropicProviderPlugin, openaiProviderPlugin } from "../src/plugins/llm/providers";

/**
 * Provider discovery is delegated to plugins: each self-registers its
 * adapter when credentials exist, skips otherwise, and the bootstrap's
 * "no provider" check counts any plugin that registered an adapter —
 * built-in or third-party.
 */
describe("provider plugins", () => {
  it("skips registration when credentials are absent", async () => {
    const runtime = Runtime.create();
    runtime.use(llmPlugin).use(openaiProviderPlugin, {}).use(anthropicProviderPlugin, {});
    runtime.start();
    const llm = runtime.ctx.get("llm") as LlmService;
    expect(llm.providers()).toEqual([]);
    await runtime.dispose();
  });

  it("self-registers adapters when credentials exist", async () => {
    const runtime = Runtime.create();
    runtime
      .use(llmPlugin)
      .use(openaiProviderPlugin, { apiKey: "sk-test", model: "gpt-test" })
      .use(anthropicProviderPlugin, { apiKey: "sk-ant-test" });
    runtime.start();
    const llm = runtime.ctx.get("llm") as LlmService;
    expect(llm.providers().sort()).toEqual(["anthropic", "openai"]);
    // A provider default model lets a bare resolve() work.
    expect(llm.resolve()).toEqual({ provider: "openai", model: "gpt-test" });
    await runtime.dispose();
  });

  it("unregisters the adapter when the runtime disposes", async () => {
    const runtime = Runtime.create();
    runtime.use(llmPlugin).use(openaiProviderPlugin, { apiKey: "sk-test" });
    runtime.start();
    const llm = runtime.ctx.get("llm") as LlmService;
    expect(llm.providers()).toEqual(["openai"]);
    await runtime.dispose();
    expect(llm.providers()).toEqual([]); // registration is a reversible effect
  });
});

describe("bootstrap provider discovery", () => {
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "FLAVOR_OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "FLAVOR_ANTHROPIC_MODEL",
    "FLAVOR_MODEL",
    "FLAVOR_MODE",
  ];
  let dir: string;
  let saved: Record<string, string | undefined>;
  let handle: AgentHandle | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-lite-providers-"));
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (handle) await handle.dispose();
    handle = undefined;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("fails loud when no provider plugin registers an adapter", () => {
    expect(() => createAgent({ cwd: dir })).toThrow(/No model provider configured/);
  });

  it("counts third-party provider plugins mounted via options.plugins", () => {
    const fakeAdapter: ModelAdapter = {
      type: "fake",
      // eslint-disable-next-line require-yield
      async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {},
    };
    const fakeProviderPlugin = definePlugin({
      name: "provider:fake",
      inject: ["llm"],
      apply(ctx) {
        return ctx.effect(
          () => (ctx.get("llm") as LlmService).registerAdapter("fake", fakeAdapter, "fake-1"),
          "provider:fake.register",
        );
      },
    });
    handle = createAgent({ cwd: dir, plugins: [{ plugin: fakeProviderPlugin }] });
    const llm = handle.runtime.ctx.get("llm") as LlmService;
    expect(llm.providers()).toEqual(["fake"]);
  });
});
