import test from "node:test";
import assert from "node:assert/strict";
import { LspFrameDecoder, applyTextEdits, normalizeWorkspaceEdit, positionToOffset } from "./index.js";

test("decodes fragmented and batched LSP frames", () => {
  const decoder = new LspFrameDecoder();
  const frame = (value) => { const body = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; };
  assert.deepEqual(decoder.push(Buffer.from(frame({ id: 1 }).slice(0, 10))), []);
  const messages = decoder.push(Buffer.from(frame({ id: 1 }).slice(10) + frame({ id: 2 })));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});

test("positions and edits preserve ordering", () => {
  const text = "alpha\r\nbeta\n";
  assert.equal(positionToOffset(text, { line: 1, character: 2 }), 9);
  const changed = applyTextEdits("one two three", [
    { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: "TWO" },
    { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, newText: "THREE" },
  ]);
  assert.equal(changed, "one TWO THREE");
});

test("overlapping edits fail", () => {
  assert.throws(() => applyTextEdits("abcdef", [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, newText: "x" },
    { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, newText: "y" },
  ]), /overlap/);
});

test("normalizes both workspace edit shapes", () => {
  const a = normalizeWorkspaceEdit({ changes: { "file:///a.ts": [{ range: {}, newText: "x" }] } });
  assert.equal(a.length, 1);
  const b = normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: "file:///b.ts" }, edits: [] }] });
  assert.equal(b[0].uri, "file:///b.ts");
});
