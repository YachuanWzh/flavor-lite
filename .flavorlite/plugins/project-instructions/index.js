import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const NAMES = new Set(["AGENTS.md", "CLAUDE.md", ".cursorrules"]);
const SKIP = new Set([".git", ".flavorlite", "node_modules", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__", "target"]);

export async function discoverInstructionFiles(cwd, options = {}) {
  const root = resolve(cwd);
  const maxFiles = positiveInt(options.maxFiles, 50);
  const found = [];
  const stack = [root];
  while (stack.length && found.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) stack.push(abs);
      else if (entry.isFile() && NAMES.has(entry.name)) {
        try { found.push({ path: abs, directory: dir, relativePath: relative(root, abs).replaceAll("\\", "/"), content: await readFile(abs, "utf8") }); } catch { /* fail-soft */ }
      }
    }
  }
  return found.sort((a, b) => depth(a.relativePath) - depth(b.relativePath) || a.relativePath.localeCompare(b.relativePath));
}

export function scopedInstructions(cwd, targetPath, files) {
  const root = resolve(cwd);
  const target = resolve(root, targetPath || ".");
  if (!inside(root, target)) throw new Error(`Path "${targetPath}" escapes the workspace`);
  return files.filter((file) => { const rel = relative(file.directory, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
}

export function renderInstructions(files, maxChars = 30_000) {
  if (!files.length) return "No compatible project instruction files apply.";
  const budget = positiveInt(maxChars, 30_000);
  let output = "";
  for (const file of files) {
    const prefix = `${output ? "\n\n" : ""}## ${file.relativePath}\n\n`;
    if (output.length + prefix.length >= budget) break;
    const room = budget - output.length - prefix.length;
    if (file.content.length > room) { output += prefix + file.content.slice(0, Math.max(0, room - 14)) + "\n…[truncated]"; break; }
    output += prefix + file.content;
  }
  return output || "No compatible project instruction files fit the configured budget.";
}

export default {
  name: "project-instructions",
  inject: ["hooks", "tools"],
  provides: ["projectInstructions"],
  apply(ctx, config = {}) {
    let cache;
    const discover = async () => cache ??= await discoverInstructionFiles(ctx.cwd, config);
    const service = { discover, async forPath(path = ".") { return scopedInstructions(ctx.cwd, path, await discover()); }, refresh() { cache = undefined; } };
    return ctx.effect(() => {
      const disposers = [ctx.provide("projectInstructions", service)];
      disposers.push(ctx.get("tools").register({
        name: "project_instructions",
        description: "Read AGENTS.md, CLAUDE.md and .cursorrules instructions that apply to a workspace path.",
        category: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" }, refresh: { type: "boolean" } } },
        async execute(args) { try { if (args.refresh) service.refresh(); return { content: renderInstructions(await service.forPath(typeof args.path === "string" ? args.path : "."), config.maxChars) }; } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; } },
      }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        const files = (await discover()).filter((file) => file.directory === resolve(ctx.cwd));
        if (files.length) event.sections.push({ name: "project-instructions", content: `Repository instructions (root scope):\n\n${renderInstructions(files, config.maxChars)}\n\nNested instruction files exist per directory; call project_instructions for files below those directories.` });
        return next(event);
      }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "project-instructions.install");
  },
};

function depth(path) { return path.split("/").length; }
function inside(root, target) { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
