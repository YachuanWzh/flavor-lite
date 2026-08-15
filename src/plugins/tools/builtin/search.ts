/**
 * Search tools: Glob (path patterns) and Grep (content regex). Implemented
 * with pure Node fs — no ripgrep binary, keeping install weight at zero.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { definePlugin } from "../../../kernel";
import type { Plugin } from "../../../kernel/types";
import { isWithinWorkspace, resolveToolPath } from "./paths";
import type { Tool } from "../registry";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "__pycache__", ".venv"]);
const MAX_FILES = 20_000;

/** Translate a glob pattern (**, *, ?) to a RegExp over slash-separated paths. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let result = "";
  let i = 0;
  while (i < normalized.length) {
    const char = normalized.charAt(i);
    if (char === "*") {
      if (normalized.charAt(i + 1) === "*") {
        // "**" crosses directory boundaries; swallow an optional leading slash
        result += ".*";
        i += 2;
        if (normalized.charAt(i) === "/") i += 1;
      } else {
        result += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      result += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(char)) {
      result += `\\${char}`;
      i += 1;
    } else {
      result += char;
      i += 1;
    }
  }
  return new RegExp(`^${result}$`, "i");
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip silently
    }
    for (const entry of entries) {
      if (++count > MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

export const globTool: Tool = {
  name: "Glob",
  category: "read",
  description:
    "Find files whose workspace-relative path matches a glob pattern (supports *, **, ?). Example: \"src/**/*.ts\". Returns sorted paths.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. \"src/**/*.ts\" or \"**/*.test.ts\"" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
    if (!pattern) return { content: "Missing required argument: pattern", isError: true };
    let regex: RegExp;
    try {
      regex = globToRegExp(pattern);
    } catch {
      return { content: `Invalid glob pattern: ${pattern}`, isError: true };
    }
    const matches: string[] = [];
    for await (const file of walkFiles(ctx.cwd)) {
      const rel = relative(ctx.cwd, file).split(sep).join("/");
      if (regex.test(rel)) matches.push(rel);
      if (matches.length >= 500) break;
    }
    matches.sort();
    if (matches.length === 0) return { content: "No files matched the pattern." };
    return { content: matches.join("\n") + (matches.length >= 500 ? "\n[Limit: 500 matches]" : "") };
  },
};

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".exe", ".dll", ".so", ".bin", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4",
]);

export const grepTool: Tool = {
  name: "Grep",
  category: "read",
  description:
    "Search file contents with a JavaScript regular expression. Returns matching lines as path:line: text. Use for locating symbols, usages, and text.",
  inputSchema: {
    type: "object",
    properties: {
      regex: { type: "string", description: "Regular expression pattern (without slashes), e.g. \"function\\\\s+foo\"" },
      path: { type: "string", description: "Optional file or directory to narrow the search" },
      caseSensitive: { type: "boolean", description: "Default true" },
    },
    required: ["regex"],
  },
  async execute(args, ctx) {
    const pattern = typeof args.regex === "string" ? args.regex : undefined;
    if (!pattern) return { content: "Missing required argument: regex", isError: true };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args.caseSensitive === false ? "i" : "");
    } catch (error) {
      return { content: `Invalid regex: ${error instanceof Error ? error.message : error}`, isError: true };
    }

    const root = args.path
      ? resolveToolPath(ctx.cwd, String(args.path))
      : ctx.cwd;
    if (!isWithinWorkspace(ctx.cwd, root)) {
      return { content: `Path escapes the workspace: ${args.path}`, isError: true };
    }

    const output: string[] = [];
    let matched = 0;

    const scanFile = async (file: string): Promise<void> => {
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) return;
      let text: string;
      try {
        text = await readFile(file, "utf-8");
      } catch {
        return;
      }
      if (text.includes("\u0000")) return; // binary guard
      const rel = relative(ctx.cwd, file).split(sep).join("/");
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line !== undefined && regex.test(line)) {
          matched += 1;
          output.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`);
          if (matched >= 200) return;
        }
      }
    };

    let rootStat;
    try {
      rootStat = await stat(root);
    } catch {
      return { content: `Path not found: ${args.path ?? ctx.cwd}`, isError: true };
    }

    if (rootStat.isFile()) {
      await scanFile(root);
    } else {
      for await (const file of walkFiles(root)) {
        await scanFile(file);
        if (matched >= 200) break;
      }
    }

    if (output.length === 0) return { content: "No matches found." };
    return { content: output.join("\n") + (matched >= 200 ? "\n[Limit: 200 matches]" : "") };
  },
};

export const globToolPlugin: Plugin = definePlugin({
  name: "tool:glob",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(globTool), "tool:glob.register");
  },
});

export const grepToolPlugin: Plugin = definePlugin({
  name: "tool:grep",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(grepTool), "tool:grep.register");
  },
});
