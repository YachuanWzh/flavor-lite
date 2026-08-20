// filediff — a flavor-lite plugin.
//
// Watches file-modifying tool calls and prints a colored +/- diff of the
// change right after the tool finishes:
//   - new file   → every line green   "+ line"
//   - deleted    → every line red     "- line"
//   - edited     → removed lines red  "- line" and added lines green "+ line",
//                  each on its own line, removals before additions per change
//
// Watched calls:
//   - Write / Edit / ApplyPatch (any write-category tool with a path arg)
//   - Shell commands that delete (rm/unlink/del/erase/rmdir/rd) or move
//     (mv/move/ren/rename) paths; directories are walked with a file cap
//
// The diff is written straight to stdout (the terminal). The model-visible
// tool result is left untouched, so ANSI codes never pollute the context.
//
// Config (flavor-plugin.json "config" field):
//   color         "auto" | "always" | "never"  (default "auto")
//   maxDiffLines  cap on printed diff lines    (default 500)
//   maxFileBytes  skip files larger than this  (default 512 KiB)
//   maxTreeFiles  cap on walked files per dir  (default 200)

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

const WRITE_TOOL_NAMES = new Set(["Write", "Edit", "ApplyPatch", "apply_patch_transaction"]);
const DELETE_VERBS = new Set(["rm", "unlink", "del", "erase", "rmdir", "rd"]);
const MOVE_VERBS = new Set(["mv", "move", "ren", "rename"]);

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const DEFAULT_MAX_DIFF_LINES = 500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TREE_FILES = 200;
// Guard the LCS matrix; fall back to a naive all-removed/all-added diff.
const MAX_LCS_CELLS = 2_000_000;

export function coordinatedTerminalWrite(ui, text, output = process.stdout) {
  ui?.pauseAnimation?.();
  output.write(text);
}

export default {
  name: "filediff",
  inject: ["hooks", "tools"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const hooks = ctx.get("hooks");
      const tools = ctx.get("tools");
      const opts = {
        color: config.color ?? "auto",
        maxDiffLines: asPositiveInt(config.maxDiffLines, DEFAULT_MAX_DIFF_LINES),
        maxFileBytes: asPositiveInt(config.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
        maxTreeFiles: asPositiveInt(config.maxTreeFiles, DEFAULT_MAX_TREE_FILES),
      };
      const snapshots = new Map(); // absolute path -> snapshot before the call

      const disposers = [];

      // Snapshot every path the tool call may touch, before it runs.
      disposers.push(
        hooks.hook("tools/before-call", async (event, next) => {
          snapshots.clear(); // drop stale entries from blocked/failed calls
          const watched = pathsFromCall(ctx.cwd, event.toolCall, event.tool, event.args);
          for (const abs of watched) {
            snapshots.set(abs, await snapshot(abs, opts));
          }
          return next(event);
        }),
      );

      // After the call succeeds, print the diff for every watched path.
      disposers.push(
        hooks.hook("tools/after-call", async (event, next) => {
          if (!event.result.isError) {
            const tool = tools.get(event.toolCall.name);
            const watched = pathsFromCall(ctx.cwd, event.toolCall, tool, event.args);
            const blocks = [];
            for (const abs of watched) {
              const before = snapshots.get(abs);
              if (!before) continue;
              const after = await snapshot(abs, opts);
              const block = renderPathDiff(ctx.cwd, abs, before, after, opts);
              if (block) blocks.push(block);
              snapshots.delete(abs);
            }
            if (blocks.length > 0) coordinatedTerminalWrite(ctx.tryGet("ui"), blocks.join("") + "\n");
          }
          return next(event);
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "filediff.install");
  },
};

// --- path discovery -------------------------------------------------------

/** Absolute paths a tool call may create, overwrite, or delete. */
function pathsFromCall(cwd, toolCall, tool, args) {
  const paths = [];

  if (toolCall.name === "Shell" || tool?.category === "shell") {
    if (typeof args.command === "string") {
      paths.push(...pathsFromShellCommand(args.command));
    }
  } else if (WRITE_TOOL_NAMES.has(toolCall.name) || tool?.category === "write") {
    const p = args.path ?? args.file_path ?? args.filePath;
    if (typeof p === "string") paths.push(p);
  }

  return [...new Set(paths.filter(Boolean))].map((p) => resolve(cwd, p));
}

function pathsFromShellCommand(command) {
  const tokens = tokenizeShell(command);
  const verb = (tokens[0] ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
  const base = basename(verb);

  if (DELETE_VERBS.has(base)) {
    return tokens.slice(1).filter(isPathToken);
  }
  if (MOVE_VERBS.has(base)) {
    return tokens.slice(1).filter(isPathToken).slice(0, 2); // [source, dest]
  }
  return [];
}

function isPathToken(token) {
  if (token === "") return false;
  if (token.startsWith("-") || token.startsWith("/")) return false; // flags
  if (/[*?[\]{}]/.test(token)) return false; // globs / brace expansion
  return true;
}

function tokenizeShell(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

// --- snapshots ------------------------------------------------------------

/** Before-state of one path: { existed, dir?, file?, content? }. Null = unreadable. */
async function snapshot(abs, opts) {
  try {
    const st = await stat(abs);
    if (st.isDirectory()) {
      const files = [];
      await walkDir(abs, files, opts);
      return { existed: true, dir: true, files };
    }
    if (!st.isFile()) return { existed: true, file: false };
    if (st.size > opts.maxFileBytes) return { existed: true, file: true, tooBig: true };
    const content = await readFile(abs, "utf-8");
    if (isBinary(content)) return { existed: true, file: true, binary: true };
    return { existed: true, file: true, content };
  } catch (err) {
    if (err && err.code === "ENOENT") return { existed: false };
    return null; // permission or other errors: skip silently
  }
}

async function walkDir(dir, out, opts) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= opts.maxTreeFiles) return;
    const p = resolve(dir, entry.name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) await walkDir(p, out, opts);
      else if (st.isFile() && st.size <= opts.maxFileBytes) {
        const content = await readFile(p, "utf-8");
        if (!isBinary(content)) out.push({ path: p, content });
      }
    } catch {
      // skip unreadable entries
    }
  }
}

// --- diff rendering -------------------------------------------------------

function renderPathDiff(cwd, abs, before, after, opts) {
  if (!after) return "";
  const color = colorFn(opts);
  const label = displayPath(cwd, abs);

  // New file: everything is an addition (green "+ line").
  if (before.existed === false && after.existed === true && after.file) {
    const lines = splitLines(after.content);
    if (lines.length === 0) return "";
    return (
      header(label, `new (+${lines.length})`, color) +
      lines.map((line) => color.green(`+ ${line}`)).join("\n") +
      "\n"
    );
  }

  // Deleted: everything is a removal (red "- line").
  if (before.existed === true && after.existed === false) {
    if (before.dir && Array.isArray(before.files)) {
      if (before.files.length === 0) return "";
      const lines = before.files.map((f) => color.red(`- ${displayPath(cwd, f.path)}`));
      const plural = before.files.length === 1 ? "file" : "files";
      return header(label, `deleted (-${before.files.length} ${plural})`, color) + lines.join("\n") + "\n";
    }
    if (!before.file || before.binary || before.tooBig) return "";
    const lines = splitLines(before.content);
    if (lines.length === 0) return "";
    return header(label, `deleted (-${lines.length})`, color) + lines.map((line) => color.red(`- ${line}`)).join("\n") + "\n";
  }

  // Edited: removed block (red) then added block (green), per change.
  if (before.file && after.file && !before.binary && !before.tooBig && !after.binary && !after.tooBig) {
    const oldLines = splitLines(before.content);
    const newLines = splitLines(after.content);
    const ops = diffLines(oldLines, newLines);
    const rendered = ops
      ? renderOps(ops, color, opts.maxDiffLines)
      : renderNaive(oldLines, newLines, color, opts.maxDiffLines);
    if (!rendered) return "";
    const dels = countKind(ops, "del", oldLines.length);
    const adds = countKind(ops, "add", newLines.length);
    return header(label, `modified (+${adds} −${dels})`, color) + rendered;
  }

  return "";
}

function header(label, status, color) {
  return `${color.dim(`── ${label}  ${status}`)}\n`;
}

/** Line-based LCS diff; null when the file is too big for the DP matrix. */
function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_LCS_CELLS) return null;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = oldLines[i] === newLines[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", text: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: oldLines[i++] });
  while (j < m) ops.push({ kind: "add", text: newLines[j++] });
  return ops;
}

/** Render change blocks as removals first, then additions, on separate lines. */
function renderOps(ops, color, maxLines) {
  const out = [];
  let printed = 0;
  let truncated = false;
  const push = (line) => {
    if (truncated) return;
    if (printed >= maxLines) {
      truncated = true;
      return;
    }
    out.push(line);
    printed++;
  };

  let i = 0;
  while (i < ops.length) {
    const block = [];
    while (i < ops.length && ops[i].kind !== "match") block.push(ops[i++]);
    if (block.length === 0) continue;
    const dels = block.filter((op) => op.kind === "del");
    const adds = block.filter((op) => op.kind === "add");
    for (const op of dels) push(color.red(`- ${op.text}`));
    for (const op of adds) push(color.green(`+ ${op.text}`));
  }

  if (out.length === 0) return "";
  const tail = truncated ? `  ${color.dim(`… diff truncated at ${maxLines} lines`)}\n` : "";
  return out.join("\n") + "\n" + tail;
}

/** Fallback for huge files: dump all removed lines, then all added lines. */
function renderNaive(oldLines, newLines, color, maxLines) {
  const out = [];
  let truncated = false;
  for (const line of oldLines) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    out.push(color.red(`- ${line}`));
  }
  if (!truncated) {
    for (const line of newLines) {
      if (out.length >= maxLines) {
        truncated = true;
        break;
      }
      out.push(color.green(`+ ${line}`));
    }
  }
  if (out.length === 0) return "";
  const tail = truncated ? `  ${color.dim(`… diff truncated at ${maxLines} lines`)}\n` : "";
  return out.join("\n") + "\n" + tail;
}

function countKind(ops, kind, fallback) {
  if (!ops) return fallback;
  return ops.filter((op) => op.kind === kind).length;
}

// --- helpers --------------------------------------------------------------

function splitLines(content) {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isBinary(content) {
  return content.slice(0, 8192).includes("\0");
}

function displayPath(cwd, abs) {
  const rel = relative(cwd, abs);
  if (rel === "") return ".";
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
}

function colorFn(opts) {
  const mode = opts.color;
  const on =
    mode === "always" || (mode === "auto" && process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
  const wrap = (code) => (text) => (on ? `${code}${text}${RESET}` : text);
  return { green: wrap(GREEN), red: wrap(RED), dim: wrap(DIM) };
}

function asPositiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
