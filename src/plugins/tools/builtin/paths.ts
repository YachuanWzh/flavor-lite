/**
 * Path helpers shared by filesystem tools.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** Resolve a tool-supplied path against the workspace root. */
export function resolveToolPath(cwd: string, input: string): string {
  return resolve(cwd, input);
}

/**
 * Lexical containment check. The permission plugin performs the authoritative
 * guard; this keeps honest tools from wandering outside the workspace.
 */
export function isWithinWorkspace(cwd: string, absolutePath: string): boolean {
  const rel = relative(resolve(cwd), resolve(absolutePath));
  return rel !== "" ? !rel.startsWith("..") && !isAbsolute(rel) : true;
}

/** Truncate a large output keeping head and tail halves. */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n... [${dropped} characters truncated] ...\n${text.slice(text.length - half)}`;
}

export function isAbsoluteInput(input: string): boolean {
  return isAbsolute(input);
}
