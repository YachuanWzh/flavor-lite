/**
 * Built-in tool composition. Mount individual tool plugins for a custom
 * surface, or `builtinTools` for the default seven.
 */

import type { Plugin } from "../../../kernel/types";
import { editToolPlugin, readToolPlugin, writeToolPlugin } from "./files";
import { globToolPlugin, grepToolPlugin } from "./search";
import { shellToolPlugin } from "./shell";
import { todoToolPlugin } from "./todo";

export const builtinTools: Plugin[] = [
  readToolPlugin,
  writeToolPlugin,
  editToolPlugin,
  globToolPlugin,
  grepToolPlugin,
  shellToolPlugin,
  todoToolPlugin,
];

export * from "./files";
export * from "./search";
export * from "./shell";
export * from "./todo";
