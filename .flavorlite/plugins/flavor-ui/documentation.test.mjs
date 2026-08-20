import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("every current plugin manifest has a user-facing README", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const missing = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".versions") continue;
    const dir = join(root, entry.name);
    try { await access(join(dir, "flavor-plugin.json")); } catch { continue; }
    try {
      const readme = await readFile(join(dir, "README.md"), "utf8");
      if (!readme.startsWith("# ") || readme.trim().length < 200) missing.push(entry.name);
    } catch { missing.push(entry.name); }
  }
  assert.deepEqual(missing.sort(), []);
});
