import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerificationPlan, formatVerificationReport, toToolResult } from "./index.js";

test("npm plans use declared scripts and quick targets changed tests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "verify-gate-"));
  await mkdir(join(cwd, "tests"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: {
    typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "tsup",
  }}));
  await writeFile(join(cwd, "tests", "unit.test.ts"), "export {}\n");
  const quick = await detectVerificationPlan(cwd, { mode: "quick", changedFiles: ["tests/unit.test.ts"] });
  assert.deepEqual(quick.map((step) => step.label), ["typecheck", "lint", "test:unit.test.ts"]);
  assert.match(quick[2].command, /unit\.test\.ts/);
  const full = await detectVerificationPlan(cwd, { mode: "full" });
  assert.deepEqual(full.map((step) => step.label), ["typecheck", "lint", "test", "build"]);
});

test("report makes the failing check and exit code explicit", () => {
  const text = formatVerificationReport([
    { label: "typecheck", command: "npm run typecheck", code: 0, durationMs: 12, output: "ok" },
    { label: "test", command: "npm test", code: 1, durationMs: 40, output: "boom" },
  ]);
  assert.match(text, /FAILED/);
  assert.match(text, /test.*exit 1/);
  assert.match(text, /boom/);
});

test("empty report explains that no checks were detected", () => {
  assert.match(formatVerificationReport([]), /No verification checks/);
});

test("tool boundary converts unexpected failures into isError results", async () => {
  const result = await toToolResult(async () => { throw new Error("invalid package metadata"); });
  assert.deepEqual(result, { content: "invalid package metadata", isError: true });
});
