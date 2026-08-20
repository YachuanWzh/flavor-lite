import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";
import { promptPlugin } from "../src/plugins/prompt";
import { skillsPlugin, type SkillsService } from "../src/plugins/skills";
import type { AfterToolCall } from "../src/plugins/tools";

describe("skills usage telemetry", () => {
  let dir = "";
  let runtime: Runtime | undefined;

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("attributes successful SKILL.md reads to the exact run and consumes them once", async () => {
    dir = await mkdtemp(join(tmpdir(), "flavor-skills-"));
    const skillFile = join(dir, ".flavorlite", "skills", "deploy", "SKILL.md");
    await mkdir(join(dir, ".flavorlite", "skills", "deploy"), { recursive: true });
    await writeFile(skillFile, "---\nname: Deploy\ndescription: deploy safely\n---\n1. deploy\n", "utf-8");

    runtime = Runtime.create({ cwd: dir });
    runtime.use(hooksPlugin).use(promptPlugin).use(skillsPlugin);
    runtime.start();
    await runtime.ready;

    const hooks = runtime.ctx.get("hooks") as HookBusService;
    await hooks.waterfall<AfterToolCall>("tools/after-call", {
      toolCall: { id: "read-1", name: "Read", args: { path: skillFile } },
      args: { path: skillFile },
      result: { content: "skill", isError: false },
      context: { cwd: dir, runId: "run-a", sessionId: "session-a" },
    });

    const skills = runtime.ctx.get("skills") as SkillsService;
    expect(await skills.usedInRun("run-b")).toEqual([]);
    expect((await skills.usedInRun("run-a")).map((skill) => skill.name)).toEqual(["Deploy"]);
    expect(await skills.usedInRun("run-a")).toEqual([]);
  });
});
