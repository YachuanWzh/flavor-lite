// astgraph import resolution — maps module specifiers to workspace files and
// turns pending unresolved references into concrete graph edges.

import { posix } from "node:path";

/** Candidate extensions tried for extensionless imports, in priority order. */
const EXTENSION_CANDIDATES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Rewrite a `.js`/`.jsx` specifier to a TypeScript candidate (ESM-style TS code
 * frequently imports "./util.js" while the source file is util.ts).
 */
function rebaseExtension(specifier) {
  if (specifier.endsWith(".js")) return `${specifier.slice(0, -3)}.ts`;
  if (specifier.endsWith(".jsx")) return `${specifier.slice(0, -4)}.tsx`;
  if (specifier.endsWith(".mjs")) return `${specifier.slice(0, -4)}.mts`;
  if (specifier.endsWith(".cjs")) return `${specifier.slice(0, -4)}.cts`;
  return undefined;
}

function normalizePath(fromFile, specifier) {
  const fromDir = posix.dirname(fromFile.split(/[/\\]/).join("/"));
  return posix.normalize(posix.join(fromDir, specifier.split(/[/\\]/).join("/")));
}

/**
 * Resolve an import specifier to a workspace-relative file path.
 * Only relative specifiers are resolved; bare package imports return undefined.
 * `exists(path)` is a predicate over workspace-relative paths.
 */
export function resolveImportPath(fromFile, specifier, exists) {
  if (specifier === undefined) return undefined;
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;
  const base = normalizePath(fromFile, specifier);

  const direct = exists(base) ? base : undefined;
  if (direct !== undefined) return direct;

  const rebased = rebaseExtension(specifier);
  if (rebased !== undefined) {
    const candidate = normalizePath(fromFile, rebased);
    if (exists(candidate)) return candidate;
  }

  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = base + ext;
    if (exists(candidate)) return candidate;
  }

  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = posix.join(base, `index${ext}`);
    if (exists(candidate)) return candidate;
  }

  return undefined;
}

/** Kept for API symmetry with codegraph-style resolution; thin wrapper. */
export function resolveModulePath(fromFile, specifier, exists) {
  return resolveImportPath(fromFile, specifier, exists);
}

/**
 * Match pending references against the exported nodes of their target files.
 *
 * @param {Array<object>} refs unresolved_refs rows (from the database)
 * @param {Map<string, Array<{id: string, name: string, isExported: boolean}>>} nodesByFile
 * @param {(path: string) => boolean} exists workspace-relative file predicate
 * @returns {{ edges: Array<object>, resolvedIds: number[] }}
 */
export function resolveRefs(refs, nodesByFile, exists) {
  const edges = [];
  const resolvedIds = [];

  for (const ref of refs) {
    if (ref.moduleSpecifier === undefined) continue;
    const targetFile = resolveImportPath(ref.filePath, ref.moduleSpecifier, exists);
    if (targetFile === undefined) continue;
    const candidates = nodesByFile.get(targetFile) ?? [];
    const match = candidates.find((node) => node.name === ref.referenceName && node.isExported);
    if (match === undefined) continue;

    const kind = ref.referenceKind === "import"
      ? "imports"
      : ref.referenceKind === "extends" || ref.referenceKind === "implements"
        ? ref.referenceKind
        : "calls";
    edges.push({ source: ref.fromNodeId, target: match.id, kind, line: ref.line, col: ref.col });
    resolvedIds.push(ref.id);
  }

  return { edges, resolvedIds };
}
