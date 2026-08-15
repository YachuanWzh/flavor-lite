/**
 * File tools: Read, Write, Edit. Each is its own plugin registering into
 * ctx.tools — mount only what you want.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { definePlugin } from "../../../kernel";
import type { Plugin } from "../../../kernel/types";
import { isWithinWorkspace, resolveToolPath, truncateOutput } from "./paths";
import type { Tool } from "../registry";

const MAX_READ_CHARS = 120_000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const readTool: Tool = {
  name: "Read",
  category: "read",
  description:
    "Read a file from the workspace. Returns text content; large files are truncated. Use offset/limit (1-based lines) for large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      offset: { type: "number", description: "1-based line number to start reading" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = str(args.path);
    if (!path) return { content: "Missing required argument: path", isError: true };
    const absolute = resolveToolPath(ctx.cwd, path);
    if (!isWithinWorkspace(ctx.cwd, absolute)) {
      return { content: `Path "${path}" escapes the workspace`, isError: true };
    }
    const raw = await readFile(absolute, "utf-8");
    let lines = raw.split("\n");
    const offset = typeof args.offset === "number" ? Math.max(1, args.offset) : 1;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const start = offset - 1;
    if (start > 0) lines = lines.slice(start);
    if (limit !== undefined) lines = lines.slice(0, limit);
    let text = lines.join("\n");
    let note = "";
    if (text.length > MAX_READ_CHARS) {
      text = truncateOutput(text, MAX_READ_CHARS);
      note = "\n[Content truncated. Use offset/limit to read in regions.]";
    }
    return { content: text + note };
  },
};

export const writeTool: Tool = {
  name: "Write",
  category: "write",
  description:
    "Create or overwrite a file inside the workspace. Parent directories are created as needed. Use Edit for partial changes to existing files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const path = str(args.path);
    const content = typeof args.content === "string" ? args.content : undefined;
    if (!path || content === undefined) {
      return { content: "Missing required arguments: path, content", isError: true };
    }
    const absolute = resolveToolPath(ctx.cwd, path);
    if (!isWithinWorkspace(ctx.cwd, absolute)) {
      return { content: `Path "${path}" escapes the workspace`, isError: true };
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf-8");
    return { content: `Wrote ${content.length} characters to ${path}` };
  },
};

export const editTool: Tool = {
  name: "Edit",
  category: "write",
  description:
    "Replace an exact text fragment in an existing file. oldText must match the file content verbatim and uniquely. Set replaceAll to replace every occurrence.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace or absolute" },
      oldText: { type: "string", description: "Exact text to replace (verbatim, including whitespace)" },
      newText: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args, ctx) {
    const path = str(args.path);
    const oldText = typeof args.oldText === "string" ? args.oldText : undefined;
    const newText = typeof args.newText === "string" ? args.newText : undefined;
    if (!path || oldText === undefined || newText === undefined) {
      return { content: "Missing required arguments: path, oldText, newText", isError: true };
    }
    if (oldText === newText) {
      return { content: "oldText and newText are identical; nothing to do", isError: true };
    }
    const absolute = resolveToolPath(ctx.cwd, path);
    if (!isWithinWorkspace(ctx.cwd, absolute)) {
      return { content: `Path "${path}" escapes the workspace`, isError: true };
    }
    const original = await readFile(absolute, "utf-8");
    const count = original.split(oldText).length - 1;
    if (count === 0) {
      return {
        content: `oldText not found in ${path}. Read the file and copy the exact current text, including whitespace.`,
        isError: true,
      };
    }
    if (count > 1 && args.replaceAll !== true) {
      return {
        content: `oldText matches ${count} locations in ${path}. Include more surrounding context to make it unique, or pass replaceAll: true.`,
        isError: true,
      };
    }
    const updated = args.replaceAll === true
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await writeFile(absolute, updated, "utf-8");
    return { content: `Edited ${path} (${args.replaceAll === true ? count : 1} replacement${count > 1 ? "s" : ""})` };
  },
};

export const readToolPlugin: Plugin = definePlugin({
  name: "tool:read",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(readTool), "tool:read.register");
  },
});

export const writeToolPlugin: Plugin = definePlugin({
  name: "tool:write",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(writeTool), "tool:write.register");
  },
});

export const editToolPlugin: Plugin = definePlugin({
  name: "tool:edit",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => ctx.get("tools").register(editTool), "tool:edit.register");
  },
});
