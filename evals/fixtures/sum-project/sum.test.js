import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "./sum.js";

test("sums finite numbers", () => assert.equal(sum([1, 2, 3]), 6));
test("rejects non-finite values", () => assert.throws(() => sum([1, Infinity]), /finite/i));
