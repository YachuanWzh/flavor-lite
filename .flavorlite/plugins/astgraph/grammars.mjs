// astgraph grammar loading — web-tree-sitter WASM runtime, vendored under ./vendor.
// Resolves the vendor directory relative to this module so it works both from the
// source tree (src/init/astgraph) and the copied plugin root (.flavorlite/plugins/astgraph).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "./vendor/tree-sitter.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = join(MODULE_DIR, "vendor");

const GRAMMAR_FILES = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
};

export const SUPPORTED_LANGUAGES = Object.keys(GRAMMAR_FILES);

export function languageForFile(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  return undefined;
}

let initialized = false;
let initPromise;
const languageCache = new Map();
const parserCache = new Map();

/** Initialize the WASM runtime once. Safe to call repeatedly. */
export async function initGrammars() {
  if (initialized) return;
  initPromise ??= Parser.init({ locateFile: (name) => join(VENDOR_DIR, name) }).then(() => {
    initialized = true;
  });
  await initPromise;
}

/** Load (and cache) a grammar for one of the supported languages. */
export async function loadLanguage(language) {
  const file = GRAMMAR_FILES[language];
  if (file === undefined) throw new Error(`astgraph: unsupported language "${language}"`);
  await initGrammars();
  let languageInstance = languageCache.get(language);
  if (languageInstance === undefined) {
    languageInstance = await Language.load(join(VENDOR_DIR, file));
    languageCache.set(language, languageInstance);
  }
  return languageInstance;
}

/** Parse source text and return the syntax tree. */
export async function parseSource(source, language) {
  const languageInstance = await loadLanguage(language);
  let parser = parserCache.get(language);
  if (parser === undefined) {
    parser = new Parser();
    parser.setLanguage(languageInstance);
    parserCache.set(language, parser);
  }
  return parser.parse(source);
}
