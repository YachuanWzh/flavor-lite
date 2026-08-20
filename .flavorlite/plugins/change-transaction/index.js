import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const DEFAULT_MAX_OPERATIONS = 50;
const DEFAULT_MAX_STAGED_BYTES = 5 * 1024 * 1024;

export async function planTransaction(cwd, operations, options = {}) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations must be a non-empty array");
  const maxOperations = positiveInt(options.maxOperations, DEFAULT_MAX_OPERATIONS);
  if (operations.length > maxOperations) throw new Error(`Too many operations: ${operations.length} (max ${maxOperations})`);
  const states = new Map();
  const virtual = new Map();
  const staged = [];
  let stagedBytes = 0;
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation.path !== "string" || !operation.path.trim()) throw new Error(`Operation ${index + 1} is missing path`);
    const abs = resolve(cwd, operation.path);
    if (!inside(cwd, abs)) throw new Error(`Path "${operation.path}" escapes the workspace`);
    let state = states.get(abs);
    if (!state) {
      state = await readState(abs);
      states.set(abs, state);
    }
    const current = virtual.has(abs) ? virtual.get(abs) : (state.exists ? state.content : undefined);
    if (operation.op === "create") {
      if (current !== undefined) throw new Error(`Cannot create ${operation.path}: path already exists`);
      if (typeof operation.content !== "string") throw new Error(`Create ${operation.path} requires content`);
      staged.push({ op: "write", abs, path: operation.path, content: operation.content });
      virtual.set(abs, operation.content);
      stagedBytes += Buffer.byteLength(operation.content);
    } else if (operation.op === "replace") {
      if (current === undefined) throw new Error(`Cannot replace ${operation.path}: file does not exist`);
      if (typeof operation.oldText !== "string" || typeof operation.newText !== "string") throw new Error(`Replace ${operation.path} requires oldText and newText`);
      if (operation.oldText === "") throw new Error(`Replace ${operation.path} requires non-empty oldText`);
      const count = occurrences(current, operation.oldText);
      if (count === 0) throw new Error(`oldText not found in ${operation.path}`);
      if (count > 1 && operation.replaceAll !== true) throw new Error(`oldText matches ${count} locations in ${operation.path}; set replaceAll or add context`);
      const content = operation.replaceAll === true ? current.split(operation.oldText).join(operation.newText) : current.replace(operation.oldText, operation.newText);
      staged.push({ op: "write", abs, path: operation.path, content });
      virtual.set(abs, content);
      stagedBytes += Buffer.byteLength(content);
    } else if (operation.op === "delete") {
      if (current === undefined) throw new Error(`Cannot delete ${operation.path}: file does not exist`);
      if (operation.expectedText !== undefined && operation.expectedText !== current) throw new Error(`Expected content does not match ${operation.path}`);
      staged.push({ op: "delete", abs, path: operation.path });
      virtual.set(abs, undefined);
    } else {
      throw new Error(`Unknown operation "${operation.op}" at index ${index}`);
    }
    if (stagedBytes > positiveInt(options.maxStagedBytes, DEFAULT_MAX_STAGED_BYTES)) throw new Error("Transaction exceeds staged byte limit");
  }
  const finalByPath = new Map();
  for (const entry of staged) finalByPath.set(entry.abs, entry);
  return { states, staged: [...finalByPath.values()] };
}

export async function applyTransaction(cwd, operations, options = {}) {
  const plan = await planTransaction(cwd, operations, options);
  const touched = [];
  try {
    for (const entry of plan.staged) {
      touched.push(entry.abs);
      if (entry.op === "delete") await rm(entry.abs, { force: false });
      else { await mkdir(dirname(entry.abs), { recursive: true }); await writeFile(entry.abs, entry.content, "utf8"); }
    }
  } catch (error) {
    for (const abs of touched.reverse()) await restoreState(abs, plan.states.get(abs)).catch(() => {});
    throw new Error(`Transaction rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, changes: plan.staged.map((entry) => ({ op: entry.op === "delete" ? "delete" : "write", path: entry.path })) };
}

export default {
  name: "change-transaction",
  inject: ["hooks", "tools"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const disposers = [];
      disposers.push(ctx.get("tools").register({
        name: "apply_patch_transaction",
        description: "Atomically apply guarded create, replace and delete operations across multiple files. All preconditions are checked before writing; any commit error rolls everything back.",
        category: "write",
        inputSchema: {
          type: "object",
          properties: {
            operations: { type: "array", items: { type: "object", properties: {
              op: { type: "string", enum: ["create", "replace", "delete"] }, path: { type: "string" },
              content: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
              replaceAll: { type: "boolean" }, expectedText: { type: "string" },
            }, required: ["op", "path"] } },
          }, required: ["operations"],
        },
        async execute(args, execCtx) {
          try {
            const result = await applyTransaction(execCtx.cwd, args.operations, config);
            return { content: `Transaction applied (${result.changes.length} files)\n${result.changes.map((change) => `- ${change.op} ${change.path}`).join("\n")}` };
          } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
        },
      }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        event.sections.push({ name: "change-transaction", content: "Prefer apply_patch_transaction for related multi-file edits. Use exact oldText preconditions so stale context fails before any file is changed." });
        return next(event);
      }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "change-transaction.install");
  },
};

async function readState(abs) {
  try { const info = await stat(abs); if (!info.isFile()) throw new Error(`${abs} is not a regular file`); return { exists: true, content: await readFile(abs, "utf8") }; }
  catch (error) { if (error?.code === "ENOENT") return { exists: false }; throw error; }
}
async function restoreState(abs, state) { if (!state?.exists) await rm(abs, { force: true }); else { await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, state.content, "utf8"); } }
function occurrences(text, needle) { if (needle === "") return text.length + 1; return text.split(needle).length - 1; }
function inside(cwd, abs) { const rel = relative(resolve(cwd), abs); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
