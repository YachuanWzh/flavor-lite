import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInstructionFiles, scopedInstructions, renderInstructions } from "./index.js";

test("discovers deterministic scoped instructions and ignores dependencies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "instructions-"));
  await mkdir(join(cwd, "packages", "a"), { recursive: true });
  await mkdir(join(cwd, "packages", "b"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "x"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "root");
  await writeFile(join(cwd, "packages", "a", "AGENTS.md"), "a");
  await writeFile(join(cwd, "packages", "b", "CLAUDE.md"), "b");
  await writeFile(join(cwd, "node_modules", "x", "AGENTS.md"), "ignored");
  const files = await discoverInstructionFiles(cwd);
  assert.deepEqual(files.map((file) => file.relativePath), ["AGENTS.md", "packages/a/AGENTS.md", "packages/b/CLAUDE.md"]);
  const scoped = scopedInstructions(cwd, "packages/a/src/x.ts", files);
  assert.deepEqual(scoped.map((file) => file.relativePath), ["AGENTS.md", "packages/a/AGENTS.md"]);
});

test("renderer enforces its character budget", () => {
  const text = renderInstructions([{ relativePath: "AGENTS.md", content: "x".repeat(100) }], 40);
  assert.ok(text.length <= 60);
  assert.match(text, /truncated/);
});
