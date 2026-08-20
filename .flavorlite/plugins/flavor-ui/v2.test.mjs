import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRenderer } from "./renderer.js";

function output(columns = 90) { return { isTTY: false, columns, chunks: [], write(chunk) { this.chunks.push(chunk); } }; }
function plain(out) { return out.chunks.join("").replace(/\x1b\[[0-9;]*m/g, ""); }

test("v2 banner carries the flight-recorder identity", () => {
  const out = output();
  createRenderer({ output: out, color: false, tty: false }).renderBanner({
    version: "2.0", model: "openai:test", mode: "default", sessionId: "s1",
    plugins: { loaded: 7, total: 8, errors: [{ name: "x", error: "bad" }] },
  });
  assert.match(plain(out), /FLAVOR\/\/LITE/);
  assert.match(plain(out), /7\/8/);
});

test("timeline uses a lifecycle rail", () => {
  const out = output();
  const ui = createRenderer({ output: out, color: false, tty: false, style: "plain" });
  ui.renderUserInput("ship it");
  ui.render({ type: "agent_start" });
  ui.render({ type: "turn_start", iteration: 1 });
  ui.render({ type: "tool_start", toolCall: { name: "Read", args: { path: "a.ts" } } });
  ui.render({ type: "tool_end", toolCall: { name: "Read", args: {} }, content: "ok", isError: false });
  ui.render({ type: "agent_end", iterations: 1, reason: "finished" });
  assert.match(plain(out), /╭─/);
  assert.match(plain(out), /├─/);
  assert.match(plain(out), /╰─/);
});

test("plain TTY mode settles a tool on the same physical row", () => {
  const out = output();
  const ui = createRenderer({ output: out, color: false, tty: true, style: "plain" });
  const call = { name: "Glob", args: { pattern: "src/**/*.ts" } };
  ui.render({ type: "tool_start", toolCall: call });
  assert.equal(out.chunks.join("").includes("\n"), false);
  ui.render({ type: "tool_end", toolCall: call, content: "3 files", isError: false });
  const raw = out.chunks.join("");
  assert.match(raw, /○ Glob/);
  assert.match(raw, /\r\x1b\[2K.*✓ Glob/);
  assert.equal((raw.match(/\n/g) ?? []).length, 1);
});

test("plugin families share one rail but expose distinct semantic badges", () => {
  const out = output();
  const ui = createRenderer({ output: out, color: false, tty: false, style: "plain" });
  ui.render({ type: "agent_start" });
  for (const name of ["Read", "verify_changes", "git_diff", "lsp_diagnostics", "process_start", "subagent_batch"]) {
    const call = { name, args: {} };
    ui.render({ type: "tool_start", toolCall: call });
    ui.render({ type: "tool_end", toolCall: call, content: "done", isError: false });
  }
  const text = plain(out);
  for (const badge of ["FILE", "VERIFY", "GIT", "LSP", "PROCESS", "AGENT"]) assert.match(text, new RegExp(`‹${badge}›`));
  assert.equal((text.match(/├─/g) ?? []).length, 12);
});

test("outcome-heavy plugin families preview success even in plain mode", () => {
  const out = output();
  const ui = createRenderer({ output: out, color: false, tty: false, style: "plain" });
  ui.render({ type: "agent_start" });
  const call = { name: "verify_changes", args: { mode: "quick" } };
  ui.render({ type: "tool_start", toolCall: call });
  ui.render({ type: "tool_end", toolCall: call, content: "Verification PASSED\nmore", isError: false });
  assert.match(plain(out), /Verification PASSED/);
});

test("plugins can override and dispose their own presentation", () => {
  const out = output();
  const ui = createRenderer({ output: out, color: false, tty: false, style: "plain" });
  const dispose = ui.registerToolPresentation("acme_scan", { badge: "ACME", accent: "amber", previewOnSuccess: true });
  const call = { name: "acme_scan", args: {} };
  ui.render({ type: "tool_start", toolCall: call });
  ui.render({ type: "tool_end", toolCall: call, content: "custom result", isError: false });
  dispose();
  ui.render({ type: "tool_start", toolCall: call });
  ui.render({ type: "tool_end", toolCall: call, content: "fallback result", isError: false });
  const text = plain(out);
  assert.match(text, /‹ACME›/);
  assert.match(text, /custom result/);
  assert.match(text, /‹TOOL›/);
  assert.doesNotMatch(text, /fallback result/);
});

test("renderer contains one banner implementation", async () => {
  const source = await readFile(new URL("./renderer.js", import.meta.url), "utf8");
  assert.equal((source.match(/function renderBanner\(/g) ?? []).length, 1);
});
