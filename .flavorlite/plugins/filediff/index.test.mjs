import test from "node:test";
import assert from "node:assert/strict";
import { coordinatedTerminalWrite } from "./index.js";

test("pauses the shared UI before writing a diff block", () => {
  const order = [];
  coordinatedTerminalWrite({ pauseAnimation() { order.push("pause"); } }, "diff", { write(value) { order.push(`write:${value}`); } });
  assert.deepEqual(order, ["pause", "write:diff"]);
});
