import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const STORE = ".flavorlite/git-safety/checkpoints";

export function parsePorcelainZ(raw) {
  const parts = raw.split("\0");
  const rows = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part.length < 4) continue;
    const code = part.slice(0, 2);
    const path = part.slice(3);
    const row = { code, path };
    if (code.includes("R") || code.includes("C")) row.originalPath = parts[++index] || undefined;
    rows.push(row);
  }
  return rows;
}

async function git(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: options.encoding ?? "utf8", maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

async function repoRoot(cwd) { return String(await git(cwd, ["rev-parse", "--show-toplevel"])).trim(); }
async function head(cwd) { return String(await git(cwd, ["rev-parse", "HEAD"])).trim(); }
async function statusRows(cwd) {
  const rows = parsePorcelainZ(String(await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])));
  return rows.filter((row) => !row.path.replaceAll("\\", "/").startsWith(".flavorlite/git-safety/") && !row.originalPath?.replaceAll("\\", "/").startsWith(".flavorlite/git-safety/"));
}

export async function createCheckpoint(cwd, label = "checkpoint", options = {}) {
  const root = await repoRoot(cwd);
  const rows = await statusRows(root);
  const paths = [...new Set(rows.flatMap((row) => [row.path, row.originalPath].filter(Boolean)))];
  const maxFiles = positiveInt(options.maxFiles, 500);
  const maxBytes = positiveInt(options.maxBytes, 10 * 1024 * 1024);
  if (paths.length > maxFiles) throw new Error(`Checkpoint has ${paths.length} files (max ${maxFiles})`);
  const files = [];
  let bytes = 0;
  for (const path of paths) {
    const abs = resolve(root, path);
    if (!inside(root, abs)) throw new Error(`Git path escapes repository: ${path}`);
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const content = await readFile(abs);
      bytes += content.length;
      if (bytes > maxBytes) throw new Error(`Checkpoint exceeds ${maxBytes} bytes`);
      files.push({ path, exists: true, content: content.toString("base64") });
    } catch (error) {
      if (error?.code === "ENOENT") files.push({ path, exists: false });
      else throw error;
    }
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const checkpoint = { id, label: String(label).slice(0, 120), createdAt: new Date().toISOString(), head: await head(root), root, files };
  const dir = resolve(root, STORE);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${id}.json`), JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpoint;
}

export async function restoreCheckpoint(cwd, id, options = {}) {
  const root = await repoRoot(cwd);
  if (!/^[\w.-]+$/.test(id)) throw new Error("Invalid checkpoint id");
  const checkpoint = JSON.parse(await readFile(resolve(root, STORE, `${id}.json`), "utf8"));
  const currentHead = await head(root);
  if (checkpoint.head !== currentHead && options.allowHeadChange !== true) throw new Error("HEAD changed since checkpoint; pass allowHeadChange to override");
  const captured = new Map(checkpoint.files.map((file) => [file.path, file]));
  const current = await statusRows(root);
  const paths = new Set([...captured.keys(), ...current.flatMap((row) => [row.path, row.originalPath].filter(Boolean))]);
  for (const path of paths) {
    const abs = resolve(root, path);
    if (!inside(root, abs)) throw new Error(`Git path escapes repository: ${path}`);
    const saved = captured.get(path);
    if (saved?.exists) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(saved.content, "base64"));
    } else if (saved && !saved.exists) {
      await rm(abs, { force: true });
    } else {
      try {
        const content = await git(root, ["show", `HEAD:${path}`], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      } catch {
        await rm(abs, { force: true });
      }
    }
  }
  return { id, restored: paths.size };
}

export async function listCheckpoints(cwd) {
  const root = await repoRoot(cwd);
  const dir = resolve(root, STORE);
  let names;
  try { names = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const entries = [];
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    try { const value = JSON.parse(await readFile(resolve(dir, name), "utf8")); entries.push(value); } catch { /* isolate corrupt checkpoint */ }
  }
  return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export default {
  name: "git-safety",
  inject: ["hooks", "tools", "commands"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const tools = ctx.get("tools");
      const disposers = [];
      const safe = (fn) => async (args, execCtx) => { try { return { content: await fn(args, execCtx) }; } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; } };
      disposers.push(tools.register({ name: "git_status", description: "Show structured Git working-tree status.", category: "read", inputSchema: { type: "object", properties: {} }, execute: safe(async (_args, execCtx) => { const rows = await statusRows(execCtx.cwd); return rows.length ? rows.map((row) => `${row.code} ${row.originalPath ? `${row.originalPath} -> ` : ""}${row.path}`).join("\n") : "Working tree clean."; }) }));
      disposers.push(tools.register({ name: "git_diff", description: "Show the current Git diff, optionally staged or limited to a path.", category: "read", inputSchema: { type: "object", properties: { staged: { type: "boolean" }, path: { type: "string" } } }, execute: safe(async (args, execCtx) => { const root = await repoRoot(execCtx.cwd); const argv = ["diff", "--no-ext-diff", "--no-color"]; if (args.staged) argv.push("--cached"); if (typeof args.path === "string") argv.push("--", args.path); return String(await git(root, argv, { maxBuffer: 2 * 1024 * 1024 })).slice(0, 100_000) || "No diff."; }) }));
      disposers.push(tools.register({ name: "git_blame", description: "Show Git blame for a file and optional line range.", category: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, start: { type: "number" }, end: { type: "number" } }, required: ["path"] }, execute: safe(async (args, execCtx) => { const argv = ["blame", "--date=short"]; if (Number.isInteger(args.start)) argv.push("-L", `${args.start},${Number.isInteger(args.end) ? args.end : args.start}`); argv.push("--", args.path); return String(await git(await repoRoot(execCtx.cwd), argv)).slice(0, 50_000); }) }));
      disposers.push(tools.register({ name: "git_checkpoint", description: "Capture current changed/untracked file contents before risky edits. Does not commit, stash or alter the worktree.", category: "write", inputSchema: { type: "object", properties: { label: { type: "string" } } }, execute: safe(async (args, execCtx) => { const value = await createCheckpoint(execCtx.cwd, args.label, config); return `Checkpoint ${value.id} captured ${value.files.length} changed paths.`; }) }));
      disposers.push(tools.register({ name: "git_restore_checkpoint", description: "Restore the working tree to a git-safety checkpoint without reset/checkout. This overwrites changes made after that checkpoint.", category: "write", inputSchema: { type: "object", properties: { id: { type: "string" }, allowHeadChange: { type: "boolean" } }, required: ["id"] }, execute: safe(async (args, execCtx) => { const value = await restoreCheckpoint(execCtx.cwd, args.id, { allowHeadChange: args.allowHeadChange }); return `Restored checkpoint ${value.id} across ${value.restored} paths.`; }) }));
      disposers.push(tools.register({ name: "git_checkpoint_list", description: "List recoverable git-safety checkpoints.", category: "read", inputSchema: { type: "object", properties: {} }, execute: safe(async (_args, execCtx) => formatList(await listCheckpoints(execCtx.cwd))) }));
      disposers.push(ctx.get("commands").register({ name: "checkpoints", description: "List git-safety checkpoints", run: async () => { try { return formatList(await listCheckpoints(ctx.cwd)); } catch (error) { return error instanceof Error ? error.message : String(error); } } }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => { event.sections.push({ name: "git-safety", content: "Before risky or broad edits in a Git repository, create a git_checkpoint. Use git_status/git_diff for inspection. Restore only when the user requests rollback or the current task clearly requires recovering agent-made changes." }); return next(event); }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "git-safety.install");
  },
};

function formatList(values) { return values.length ? values.map((value) => `${value.id}  ${value.createdAt}  ${value.files.length} paths  ${value.label}`).join("\n") : "No checkpoints."; }
function inside(root, abs) { const rel = relative(resolve(root), abs); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
