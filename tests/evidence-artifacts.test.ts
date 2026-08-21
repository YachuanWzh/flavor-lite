import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Runtime } from "../src/kernel";
import { artifactsPlugin, type ArtifactService } from "../src/plugins/artifacts";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { evidencePlugin, type EvidenceService } from "../src/plugins/evidence";
import { hooksPlugin } from "../src/plugins/hooks";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";

describe("evidence and artifacts", () => {
  let dir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-evidence-"));
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("evaluates required evidence and accepts user feedback", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(commandsPlugin).use(evidencePlugin);
    runtime.start();
    const evidence = runtime.ctx.get("evidence") as EvidenceService;
    evidence.begin("run-1");
    evidence.record("run-1", { kind: "test", status: "fail", summary: "tests failed", required: true });
    expect(evidence.evaluate("run-1", "success", 0)).toMatchObject({ successful: false });
    const commands = runtime.ctx.get("commands") as CommandsService;
    expect(await commands.execute("/evidence fail user found regression")).toContain("recorded fail feedback");
  });

  it("persists oversized tool output and returns a bounded transcript", async () => {
    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(toolsPlugin, { maxOutputChars: 1_000 }).use(artifactsPlugin);
    runtime.start();
    const tools = runtime.ctx.get("tools") as ToolRegistry;
    tools.register({
      name: "large",
      description: "large output",
      category: "read",
      inputSchema: { type: "object" },
      async execute() { return { content: "x".repeat(5_000) }; },
    });
    const result = await tools.execute({ id: "1", name: "large", args: {} }, { cwd: dir, runId: "run-1" });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(1_000);
    expect(result.artifacts).toHaveLength(1);
    const store = runtime.ctx.get("artifacts") as ArtifactService;
    expect(String(await store.read(result.artifacts![0]!.id))).toHaveLength(5_000);
  });
});
